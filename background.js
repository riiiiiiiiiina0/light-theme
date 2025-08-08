/**
 * Background service worker for the Light Theme extension
 */

// Import storage module for URL operations
import { getUrls, addUrl, deleteUrl } from './storage.js';

/**
 * Decide whether to inject inversion CSS and which icon to show,
 * based on system theme, page theme and whether URL is in stored list.
 */
function decideInjectionAndIcon(systemTheme, pageTheme, isInStoredList) {
  // Normalize
  const sys = systemTheme === 'dark' ? 'dark' : 'light';
  const page = pageTheme === 'dark' ? 'dark' : 'light';

  // Truth table implementation
  if (sys === 'light') {
    if (page === 'light') {
      return { shouldInject: false, icon: 'icons/icon-light-48x48.png' };
    }
    // page is dark
    if (isInStoredList) {
      return { shouldInject: true, icon: 'icons/icon-light-48x48.png' };
    }
    return { shouldInject: false, icon: 'icons/icon-dark-48x48.png' };
  }

  // sys === 'dark'
  if (page === 'dark') {
    return { shouldInject: false, icon: 'icons/icon-dark-48x48.png' };
  }
  // page is light
  if (isInStoredList) {
    return { shouldInject: true, icon: 'icons/icon-dark-48x48.png' };
  }
  return { shouldInject: false, icon: 'icons/icon-light-48x48.png' };
}

/**
 * Detect current page theme (light/dark) and system theme for a tab.
 * New approach: capture a JPEG thumbnail of the active tab and analyze pixels.
 * Falls back to computed-style detection when capture is unavailable.
 */
async function detectThemesInTab(tabId) {
  try {
    // Always attempt to read system theme and a fallback page theme from within the page
    const [inPage] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Runs in page context
        const prefersDark =
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-color-scheme: dark)').matches;

        function parseRgbStringToRgb(colorStr) {
          if (!colorStr) return { r: 255, g: 255, b: 255, a: 1 };
          const match = colorStr
            .replace(/\s+/g, '')
            .match(/^rgba?\((\d+),(\d+),(\d+)(?:,(\d*\.?\d+))?\)$/i);
          if (!match) {
            if (colorStr.toLowerCase() === 'transparent') {
              return { r: 255, g: 255, b: 255, a: 0 };
            }
            const temp = document.createElement('div');
            temp.style.color = colorStr;
            document.body.appendChild(temp);
            const cs = getComputedStyle(temp).color;
            temp.remove();
            return parseRgbStringToRgb(cs);
          }
          return {
            r: Number(match[1]),
            g: Number(match[2]),
            b: Number(match[3]),
            a: match[4] !== undefined ? Number(match[4]) : 1,
          };
        }

        function srgbToLinear(channel) {
          const c = channel / 255;
          return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        }

        function relativeLuminance(rgb) {
          const r = srgbToLinear(rgb.r);
          const g = srgbToLinear(rgb.g);
          const b = srgbToLinear(rgb.b);
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }

        function getEffectiveBackgroundColor(element) {
          let el = element;
          while (el) {
            const bg = getComputedStyle(el).backgroundColor;
            const rgba = parseRgbStringToRgb(bg);
            if (rgba.a !== 0 && bg.toLowerCase() !== 'transparent') {
              return rgba;
            }
            el = el.parentElement;
          }
          const docBg = getComputedStyle(
            document.documentElement,
          ).backgroundColor;
          const parsedDocBg = parseRgbStringToRgb(docBg);
          if (parsedDocBg.a !== 0 && docBg.toLowerCase() !== 'transparent') {
            return parsedDocBg;
          }
          return { r: 255, g: 255, b: 255, a: 1 };
        }

        const root = document.body || document.documentElement;
        const bgRgb = getEffectiveBackgroundColor(root);
        const textColorStr = getComputedStyle(root).color;
        const textRgb = parseRgbStringToRgb(textColorStr);
        const bgLum = relativeLuminance(bgRgb);
        const textLum = relativeLuminance(textRgb);
        const fallbackPageTheme = bgLum < textLum ? 'dark' : 'light';

        return {
          systemTheme: prefersDark ? 'dark' : 'light',
          fallbackPageTheme,
        };
      },
    });

    const systemTheme = inPage?.result?.systemTheme || 'light';
    let pageThemeFromScreenshot = null;

    // Attempt screenshot-based detection only if the tab is active in its window
    let tabInfo = null;
    try {
      tabInfo = await chrome.tabs.get(tabId);
    } catch (_) {
      tabInfo = null;
    }

    if (
      tabInfo?.active &&
      typeof chrome.tabs.captureVisibleTab === 'function' &&
      typeof OffscreenCanvas === 'function' &&
      typeof createImageBitmap === 'function'
    ) {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tabInfo.windowId, {
          format: 'jpeg',
          quality: 70,
        });
        if (dataUrl) {
          const response = await fetch(dataUrl);
          const blob = await response.blob();
          const bitmap = await createImageBitmap(blob);

          // Scale down to a small thumbnail while preserving aspect ratio
          const longestSide = Math.max(bitmap.width, bitmap.height);
          const targetLongest = 96; // thumbnail target
          const scale =
            longestSide > targetLongest ? targetLongest / longestSide : 1;
          const thumbWidth = Math.max(1, Math.round(bitmap.width * scale));
          const thumbHeight = Math.max(1, Math.round(bitmap.height * scale));

          const canvas = new OffscreenCanvas(thumbWidth, thumbHeight);
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) {
            bitmap.close?.();
            throw new Error('2D context not available');
          }
          ctx.drawImage(bitmap, 0, 0, thumbWidth, thumbHeight);
          bitmap.close?.();

          const imageData = ctx.getImageData(0, 0, thumbWidth, thumbHeight);
          const data = imageData.data;

          // Compute average relative luminance over all pixels
          let luminanceSum = 0;
          const pixelCount = data.length / 4;
          const srgbToLinear = (c8) => {
            const c = c8 / 255;
            return c <= 0.04045
              ? c / 12.92
              : Math.pow((c + 0.055) / 1.055, 2.4);
          };
          for (let i = 0; i < data.length; i += 4) {
            const r = srgbToLinear(data[i]);
            const g = srgbToLinear(data[i + 1]);
            const b = srgbToLinear(data[i + 2]);
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            luminanceSum += lum;
          }
          const avgLum = luminanceSum / pixelCount;
          pageThemeFromScreenshot = avgLum < 0.5 ? 'dark' : 'light';
        }
      } catch (_) {
        // Ignore capture errors and fall back
      }
    }

    const pageTheme =
      pageThemeFromScreenshot ?? inPage?.result?.fallbackPageTheme ?? 'light';
    return { systemTheme, pageTheme };
  } catch (error) {
    console.warn('Theme detection failed for tab', tabId, error);
    return null;
  }
}

/**
 * Determine whether a URL is covered by the stored list (prefix match).
 */
function urlIsInStoredList(url, storedUrls) {
  if (!url) return false;
  try {
    return storedUrls.some((u) => url.startsWith(u));
  } catch {
    return false;
  }
}

/**
 * Inject the inversion CSS content script.
 */
async function applyFlip(tabId) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-add-style.js'],
    });
  } catch (error) {
    console.warn('Failed to apply flip on tab', tabId, error);
  }
}

/**
 * Remove the inversion CSS content script effects.
 */
async function removeFlip(tabId) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-remove-style.js'],
    });
  } catch (error) {
    console.warn('Failed to remove flip on tab', tabId, error);
  }
}

/**
 * Set the action icon for a tab.
 */
function setIcon(tabId, iconPath) {
  if (!tabId) return;
  chrome.action.setIcon({ path: iconPath, tabId });
}

/**
 * Evaluate a tab: detect themes, check stored list, decide injection and icon, and apply.
 */
async function evaluateTab(tabId, url) {
  if (!tabId || !url) {
    setIcon(tabId, 'icons/icon-dark-48x48.png');
    return;
  }

  try {
    const [storedUrls, detection] = await Promise.all([
      getUrls(),
      detectThemesInTab(tabId),
    ]);

    if (!detection) {
      // If detection failed, fall back to icon by stored list and do not inject
      const inList = urlIsInStoredList(url, storedUrls);
      setIcon(
        tabId,
        inList ? 'icons/icon-light-48x48.png' : 'icons/icon-dark-48x48.png',
      );
      return;
    }

    const isInList = urlIsInStoredList(url, storedUrls);
    const { shouldInject, icon } = decideInjectionAndIcon(
      detection.systemTheme,
      detection.pageTheme,
      isInList,
    );

    if (shouldInject) {
      await applyFlip(tabId);
    } else {
      await removeFlip(tabId);
    }

    setIcon(tabId, icon);
  } catch (error) {
    console.error('Error evaluating tab', tabId, error);
    setIcon(tabId, 'icons/icon-dark-48x48.png');
  }
}

// Listen for tab updates
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (
    tab?.url &&
    (changeInfo.status === 'loading' || changeInfo.status === 'complete')
  ) {
    await evaluateTab(tabId, tab.url);
  }
});

// Listen for history state updates (e.g., SPA navigations)
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId === 0 && details.url) {
    await evaluateTab(details.tabId, details.url);
  }
});

// Listen for extension action button clicks (toggle stored list membership for origin)
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab?.url) return;
  try {
    const origin = new URL(tab.url).origin;
    const urls = await getUrls();
    const exists = urls.some((u) => u === origin);

    if (exists) {
      await deleteUrl(origin);
    } else {
      await addUrl(origin);
    }

    // Re-evaluate after update
    await evaluateTab(tab.id, tab.url);
  } catch (error) {
    console.error('Error toggling URL:', error);
  }
});

// Listen for when the active tab changes
// chrome.tabs.onActivated.addListener(async (activeInfo) => {
//   try {
//     const tab = await chrome.tabs.get(activeInfo.tabId);
//     if (tab?.url) {
//       await evaluateTab(activeInfo.tabId, tab.url);
//     }
//   } catch (error) {
//     console.warn('Error in onActivated listener:', error);
//   }
// });

// Initialize icons for already open tabs when the extension starts
async function initializeTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && tab.url) {
        await evaluateTab(tab.id, tab.url);
      }
    }
  } catch (error) {
    console.error('Error initializing tabs:', error);
  }
}

// Run initialization
initializeTabs();
