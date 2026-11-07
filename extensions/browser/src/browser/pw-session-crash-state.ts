import type { Page } from "playwright-core";
import { CrashedBrowserTargetError } from "./errors.js";

// Renderer crashes are page-scoped and permanent for that Page object; a WeakSet
// lets the mark die with the page without manual cleanup bookkeeping.
const crashedPages = new WeakSet<Page>();

export function markPageCrashed(page: Page): void {
  crashedPages.add(page);
}

export function isPageCrashed(page: Page): boolean {
  return crashedPages.has(page);
}

const BROWSER_TARGET_CRASHED_RE = /target crashed/i;

/** Translate a Playwright "Target crashed" failure into the explicit crash error, else null. */
export function translateCrashedPageError(err: unknown): CrashedBrowserTargetError | null {
  const message = err instanceof Error ? err.message : String(err);
  if (!BROWSER_TARGET_CRASHED_RE.test(message)) {
    return null;
  }
  return new CrashedBrowserTargetError(err instanceof Error ? { cause: err } : undefined);
}
