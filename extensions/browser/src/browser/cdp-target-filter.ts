/**
 * CDP target filtering helpers.
 *
 * Browser-internal pages cannot be reliably automated as user content, and
 * non-page targets (OOPIFs, workers) must never be exposed as tabs: closing an
 * iframe target via /json/close destroys the page hosting it. Tab selection
 * filters both classes before exposing targets to browser actions.
 */
const BROWSER_INTERNAL_TARGET_URL_PREFIXES = [
  "chrome://",
  "chrome-untrusted://",
  "devtools://",
  "edge://",
  "brave://",
  "vivaldi://",
  "opera://",
];

type BrowserTargetLike = {
  url?: string | null;
  type?: string | null;
};

/** Return true for browser-owned chrome/devtools/internal URLs. */
function isBrowserInternalTargetUrl(url: string | null | undefined): boolean {
  const normalized = url?.trim().toLowerCase() ?? "";
  return BROWSER_INTERNAL_TARGET_URL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Return true for CDP target types that are not top-level pages (iframe,
 * worker, service_worker, ...). Missing/empty type stays selectable because
 * some callers (e.g. Playwright page listings) filter url-only shapes for
 * targets already known to be pages.
 */
function isNonPageTargetType(type: string | null | undefined): boolean {
  const normalized = type?.trim().toLowerCase() ?? "";
  return normalized !== "" && normalized !== "page";
}

/** Return true when a CDP target should be selectable by user-facing actions. */
export function isSelectableCdpBrowserTarget(target: BrowserTargetLike): boolean {
  return !isNonPageTargetType(target.type) && !isBrowserInternalTargetUrl(target.url);
}
