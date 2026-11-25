/**
 * CDP target filtering helpers.
 *
 * Browser-internal pages cannot be reliably automated as user content, so tab
 * selection filters them before exposing targets to browser actions. Chrome's
 * settings and password manager pages are the one exception, and only for the
 * operator in the Control UI Browser panel: they hold payment cards and saved
 * passwords, so agent and CLI callers never see or address them.
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

// Hosts under chrome:// that only the operator may open, list and use.
const OPERATOR_ONLY_CHROME_PAGE_HOSTS = new Set(["settings", "password-manager"]);

/** Return true for chrome://settings and chrome://password-manager pages. */
export function isOperatorOnlyBrowserPageUrl(url: string | null | undefined): boolean {
  const parsed = URL.parse(url?.trim().toLowerCase() ?? "");
  return parsed?.protocol === "chrome:" && OPERATOR_ONLY_CHROME_PAGE_HOSTS.has(parsed.hostname);
}

/** Set only for requests from the operator's own Control UI connection. */
export type OperatorBrowserPagesOption = { includeOperatorPages?: boolean };

type BrowserTargetUrlLike = {
  url?: string | null;
  type?: string | null;
};

/** Return true for browser-owned chrome/devtools/internal URLs. */
function isBrowserInternalTargetUrl(url: string | null | undefined): boolean {
  const normalized = url?.trim().toLowerCase() ?? "";
  return BROWSER_INTERNAL_TARGET_URL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isSelectableCdpBrowserTarget(
  target: BrowserTargetUrlLike,
  options?: OperatorBrowserPagesOption,
): boolean {
  return (
    target.type === "page" &&
    (!isBrowserInternalTargetUrl(target.url) ||
      (options?.includeOperatorPages === true && isOperatorOnlyBrowserPageUrl(target.url)))
  );
}
