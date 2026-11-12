/**
 * CDP target filtering helpers.
 *
 * Browser-internal pages cannot be reliably automated as user content, so tab
 * selection filters them before exposing targets to browser actions.
 */
const BROWSER_INTERNAL_TARGET_URL_PREFIXES = [
  "chrome://",
  "chrome-untrusted://",
  "chrome-extension://",
  "devtools://",
  "edge://",
  "brave://",
  "vivaldi://",
  "opera://",
];

const OPERATOR_SELECTABLE_INTERNAL_PREFIXES = ["chrome://settings"];

export function isOperatorSelectableInternalUrl(url: string | null | undefined): boolean {
  const normalized = url?.trim().toLowerCase() ?? "";
  return OPERATOR_SELECTABLE_INTERNAL_PREFIXES.some(
    (prefix) =>
      normalized === prefix ||
      normalized.startsWith(`${prefix}/`) ||
      normalized.startsWith(`${prefix}?`),
  );
}

type BrowserTargetUrlLike = {
  url?: string | null;
  type?: string | null;
};

/** Return true for browser-owned chrome/devtools/internal URLs. */
export function isBrowserInternalTargetUrl(url: string | null | undefined): boolean {
  const normalized = url?.trim().toLowerCase() ?? "";
  return BROWSER_INTERNAL_TARGET_URL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isSelectableCdpBrowserTarget(
  target: BrowserTargetUrlLike,
  options?: { includeOperatorInternal?: boolean },
): boolean {
  if (target.type !== "page") {
    return false;
  }
  if (!isBrowserInternalTargetUrl(target.url)) {
    return true;
  }
  return Boolean(options?.includeOperatorInternal && isOperatorSelectableInternalUrl(target.url));
}
