import { DEFAULT_BROWSER_LOCAL_CDP_READY_TIMEOUT_MS } from "./constants.js";

/** Maximum managed page tabs kept open per active session before best-effort cleanup starts. */
export const MANAGED_BROWSER_PAGE_TAB_LIMIT = 8;

/** Upper bound on total managed page tabs across all concurrent sessions on one profile. */
export const MAX_MANAGED_BROWSER_PAGE_TAB_LIMIT = 24;

export const OPEN_TAB_DISCOVERY_WINDOW_MS = 2000;
export const OPEN_TAB_DISCOVERY_POLL_MS = 100;

export const CDP_READY_AFTER_LAUNCH_WINDOW_MS = DEFAULT_BROWSER_LOCAL_CDP_READY_TIMEOUT_MS;
export const CDP_READY_AFTER_LAUNCH_POLL_MS = 100;
export const CDP_READY_AFTER_LAUNCH_MIN_TIMEOUT_MS = 75;
