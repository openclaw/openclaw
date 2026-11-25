/** Maximum managed page tabs kept open before best-effort cleanup starts. */
export const MANAGED_BROWSER_PAGE_TAB_LIMIT = 8;

export const OPEN_TAB_DISCOVERY_WINDOW_MS = 2000;
export const OPEN_TAB_DISCOVERY_POLL_MS = 100;

/**
 * Chrome acknowledges a tab close before the page is gone. A normal close lists
 * the tab for ~10-20ms and a hung renderer for ~500ms (Chrome's unload timeout).
 */
export const CLOSE_TAB_VERIFY_WINDOW_MS = 2000;
export const CLOSE_TAB_VERIFY_POLL_MS = 50;

export const CDP_READY_AFTER_LAUNCH_POLL_MS = 100;
export const CDP_READY_AFTER_LAUNCH_MIN_TIMEOUT_MS = 75;
