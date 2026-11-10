// Renderer crashes leave the Chrome target listed but every page-level CDP command
// unanswered, so callers cannot tell a dead tab from a slow one without a bounded
// probe. Keep the observed crash evidence here; target ids are per-page and not
// reused by a running browser.
const MAX_TRACKED_CRASHED_TARGETS = 64;
// Expire observations so a transiently blocked page is not permanently demoted.
const CRASHED_TARGET_TTL_MS = 5 * 60_000;
const crashedTargets = new Map<string, number>();

function targetKey(cdpUrl: string | undefined, targetId: string): string | null {
  const base = cdpUrl?.replace(/\/+$/, "");
  return base ? `${base}\n${targetId}` : null;
}

// A dead renderer and a long-blocked main thread are indistinguishable from a
// page-level probe, so the wording names both and keeps the tab-level recovery.
export const BROWSER_TARGET_CRASHED_MESSAGE =
  "The tab crashed or stopped responding. The browser and other tabs are still available: " +
  "open the page again in a new tab, or retry this target once the page settles.";

export class BrowserTargetCrashedError extends Error {
  constructor(message = BROWSER_TARGET_CRASHED_MESSAGE) {
    super(message);
    this.name = "BrowserTargetCrashedError";
  }
}

// Only the browser's own crash frame proves a dead renderer. Page-script and
// locator errors can contain the same words while the renderer is healthy, so
// match the exact Chrome/Playwright headline instead of scanning substrings.
// Playwright appends its diagnostic block after that headline, for example
// `page.screenshot: Target crashed\nCall log:\n  - taking page screenshot`, so
// only the first line is the frame; later lines stay out of the match.
const BROWSER_TARGET_CRASH_HEADLINE_RE = /^(?:[a-z][\w.]*: )?Target crashed$/;

export function isBrowserTargetCrashMessage(message: string): boolean {
  const [headline = ""] = message.trim().split("\n", 1);
  return BROWSER_TARGET_CRASH_HEADLINE_RE.test(headline.trimEnd());
}

/** Map Playwright/CDP crash wording onto the tab-scoped error. */
export function toBrowserTargetCrashedError(err: unknown): BrowserTargetCrashedError | null {
  if (err instanceof BrowserTargetCrashedError) {
    return err;
  }
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return message && isBrowserTargetCrashMessage(message) ? new BrowserTargetCrashedError() : null;
}

export function markBrowserTargetCrashed(cdpUrl: string, targetId: string): void {
  const key = targetKey(cdpUrl, targetId);
  if (!key) {
    return;
  }
  crashedTargets.delete(key);
  crashedTargets.set(key, Date.now());
  while (crashedTargets.size > MAX_TRACKED_CRASHED_TARGETS) {
    const oldest = crashedTargets.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    crashedTargets.delete(oldest);
  }
}

export function clearBrowserTargetCrashed(cdpUrl: string, targetId: string): void {
  const key = targetKey(cdpUrl, targetId);
  if (key) {
    crashedTargets.delete(key);
  }
}

export function isBrowserTargetCrashed(cdpUrl: string, targetId: string): boolean {
  const key = targetKey(cdpUrl, targetId);
  if (!key) {
    return false;
  }
  const markedAt = crashedTargets.get(key);
  if (markedAt === undefined) {
    return false;
  }
  if (Date.now() - markedAt > CRASHED_TARGET_TTL_MS) {
    crashedTargets.delete(key);
    return false;
  }
  return true;
}
