import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { monotonicNow } from "openclaw/plugin-sdk/time-runtime";
import type { Page } from "playwright-core";
import { BROWSER_ACTION_NAVIGATION_GRACE_MS } from "./act-policy.js";
import type { BrowserDownloadCandidate, BrowserDownloadResult } from "./download-types.js";
import type { ActionDownloadCapture } from "./pw-session-contracts.js";
import { ensurePageState } from "./pw-session-state.js";

const ACT_DOWNLOAD_MAX_DRAIN_MS = 1_000;

export function isDownloadStartingNavigationError(err: unknown, expectedUrl?: string): boolean {
  const message = formatErrorMessage(err).toLowerCase();
  if (message.includes("download is starting")) {
    return true;
  }
  const normalizedUrl = normalizeOptionalString(expectedUrl)?.toLowerCase();
  return Boolean(
    normalizedUrl && message.includes("net::err_aborted") && message.includes(normalizedUrl),
  );
}

/** Capture downloads started synchronously by one Browser action. */
export function beginActionDownloadCaptureOnPage(
  page: Page,
  opts: {
    beforeSave?: (download: BrowserDownloadCandidate) => Promise<void> | void;
  } = {},
): {
  drain: (opts?: { firstEventGraceMs?: number }) => Promise<BrowserDownloadResult[] | undefined>;
  dispose: () => void;
} {
  const state = ensurePageState(page);
  const capture: ActionDownloadCapture = {
    pending: [],
    waiters: [],
    ...(opts.beforeSave ? { beforeSave: opts.beforeSave } : {}),
  };
  // One page event belongs to one action. A newer overlapping action owns
  // future events; older captures may still drain saves they already started.
  state.actionDownloadCapture = capture;
  const detach = () => {
    if (state.actionDownloadCapture === capture) {
      state.actionDownloadCapture = undefined;
    }
    for (const finish of capture.waiters.splice(0)) {
      finish();
    }
  };

  return {
    drain: async (drainOpts = {}) => {
      const waitForEvent = async (timeoutMs: number) => {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            capture.waiters = capture.waiters.filter((waiter) => waiter !== finish);
            resolve();
          };
          const timer = setTimeout(finish, timeoutMs);
          capture.waiters.push(finish);
        });
      };
      const firstEventGraceMs = Math.max(0, drainOpts.firstEventGraceMs ?? 0);
      const deadlineAtMs = monotonicNow() + ACT_DOWNLOAD_MAX_DRAIN_MS;
      const remainingBudgetMs = () => Math.max(0, deadlineAtMs - monotonicNow());
      if (capture.pending.length === 0 && firstEventGraceMs > 0) {
        await waitForEvent(Math.min(firstEventGraceMs, remainingBudgetMs()));
      }
      while (capture.lastEventAtMs !== undefined) {
        const remainingQuietMs = Math.min(
          BROWSER_ACTION_NAVIGATION_GRACE_MS - (Date.now() - capture.lastEventAtMs),
          remainingBudgetMs(),
        );
        if (remainingQuietMs <= 0) {
          break;
        }
        await waitForEvent(remainingQuietMs);
      }
      // Establish event ownership before awaiting file I/O. Slow saves must not
      // hold the action window open and absorb unrelated later downloads.
      detach();
      const downloads = await Promise.all(capture.pending);
      return downloads.length > 0 ? downloads : undefined;
    },
    dispose: detach,
  };
}
