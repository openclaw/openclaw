const NAVIGATION_USERINFO_PROTOCOLS = new Set(["http:", "https:"]);

export const BROWSER_NAVIGATION_USERINFO_BLOCKED_MESSAGE =
  "Navigation blocked: URLs with embedded credentials are not supported";

export function hasBrowserNavigationUrlUserInfo(parsed: URL): boolean {
  return (
    NAVIGATION_USERINFO_PROTOCOLS.has(parsed.protocol) &&
    (parsed.username.length > 0 || parsed.password.length > 0)
  );
}

export function assertNoBrowserNavigationUrlUserInfo(url: string): void {
  try {
    if (hasBrowserNavigationUrlUserInfo(new URL(url.trim()))) {
      throw new Error(BROWSER_NAVIGATION_USERINFO_BLOCKED_MESSAGE);
    }
  } catch (err) {
    if (err instanceof Error && err.message === BROWSER_NAVIGATION_USERINFO_BLOCKED_MESSAGE) {
      throw err;
    }
  }
}

export function redactBrowserNavigationUrlForDiagnostics(url: string): string {
  try {
    const parsed = new URL(url);
    if (hasBrowserNavigationUrlUserInfo(parsed)) {
      parsed.username = "";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return url.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/?#\s@]+)@/gi, "$1[redacted]@");
  }
}
