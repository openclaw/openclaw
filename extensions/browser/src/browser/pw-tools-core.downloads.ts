/**
 * File chooser, dialog, and download helpers for Playwright-backed browser
 * tools.
 */
import path from "node:path";
import type { Page } from "playwright-core";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS } from "./constants.js";
import type { BrowserDownloadResult } from "./download-types.js";
import {
  type BrowserNavigationPolicyOptions,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import { resolveStrictExistingUploadPaths } from "./paths.js";
import { createDownloadCaptureForPage } from "./pw-download-capture.js";
import {
  assertBrowserDownloadSaveAllowed,
  assertInteractionNavigationCompletedSafely,
  awaitActionWithAbort,
  createAbortPromiseWithListener,
  hasBrowserNavigationPolicy,
} from "./pw-interaction-navigation-guard.js";
import {
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId as getPageForTargetIdBase,
  refLocator,
  respondOrArmObservedDialogOnPage,
  restoreRoleRefsForTarget,
} from "./pw-session.js";
import {
  bumpDownloadArmId,
  bumpUploadArmId,
  normalizeTimeoutMs,
  requireRef,
  toAIFriendlyError,
} from "./pw-tools-core.shared.js";

function getPageForTargetId(
  opts: { cdpUrl: string; targetId?: string } & BrowserNavigationPolicyOptions,
) {
  return getPageForTargetIdBase({
    ...opts,
    pageNavigationPolicy: withBrowserNavigationPolicy(opts.ssrfPolicy, {
      browserProxyMode: opts.browserProxyMode,
    }),
  });
}

function createExplicitDownloadCapture(
  params: {
    page: Page;
    state: ReturnType<typeof ensurePageState>;
    timeoutMs: number;
    outPath?: string;
    rootDir?: string;
  } & BrowserNavigationPolicyOptions,
) {
  params.state.armIdDownload = bumpDownloadArmId();
  const armId = params.state.armIdDownload;
  return createDownloadCaptureForPage(params.page, params.state, params.timeoutMs, {
    mode: "explicit",
    outputPath: params.outPath,
    outputRoot: params.rootDir,
    beforeSave: async (download) => {
      if (params.state.armIdDownload !== armId) {
        throw new Error("Download was superseded by another waiter");
      }
      if (!hasBrowserNavigationPolicy(params)) {
        return;
      }
      if (!download.url) {
        throw new Error("Download URL is unavailable");
      }
      await assertBrowserDownloadSaveAllowed({
        downloadUrl: download.url,
        page: params.page,
        ssrfPolicy: params.ssrfPolicy,
        browserProxyMode: params.browserProxyMode,
      });
    },
  });
}

function resolveImplicitDownloadRoot(): string {
  return path.join(resolvePreferredOpenClawTmpDir(), "downloads");
}

/** Arms the next page file chooser and fills it with strict existing paths. */
export async function armFileUploadViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    paths?: string[];
    timeoutMs?: number;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  const timeout = normalizeTimeoutMs(opts.timeoutMs, DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS);

  state.armIdUpload = bumpUploadArmId();
  const armId = state.armIdUpload;

  // The waiter is intentionally detached: the tool call arms future browser UI,
  // while the later user click opens the chooser.
  void page
    .waitForEvent("filechooser", { timeout })
    .then(async (fileChooser) => {
      if (state.armIdUpload !== armId) {
        return;
      }
      if (!opts.paths?.length) {
        // Playwright removed `FileChooser.cancel()`; best-effort close the chooser instead.
        try {
          await page.keyboard.press("Escape");
        } catch {
          // Best-effort.
        }
        return;
      }
      const uploadPathsResult = await resolveStrictExistingUploadPaths({
        requestedPaths: opts.paths,
      });
      if (!uploadPathsResult.ok) {
        try {
          await page.keyboard.press("Escape");
        } catch {
          // Best-effort.
        }
        return;
      }
      if (state.armIdUpload !== armId) {
        return;
      }
      if (!hasBrowserNavigationPolicy(opts)) {
        await fileChooser.setFiles(uploadPathsResult.paths);
        return;
      }
      const previousUrl = page.url();
      await assertInteractionNavigationCompletedSafely({
        action: async () => {
          if (state.armIdUpload !== armId) {
            return;
          }
          await fileChooser.setFiles(uploadPathsResult.paths);
        },
        cdpUrl: opts.cdpUrl,
        page,
        previousUrl,
        targetId: opts.targetId,
        ssrfPolicy: opts.ssrfPolicy,
        browserProxyMode: opts.browserProxyMode,
      });
    })
    .catch(() => {
      // Ignore timeouts; the chooser may never appear.
    });
}

/** Accepts or dismisses a pending dialog, or arms the next matching dialog response. */
export async function armDialogViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    dialogId?: string;
    accept: boolean;
    promptText?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  opts.signal?.throwIfAborted();
  const page = await getPageForTargetId(opts);
  opts.signal?.throwIfAborted();
  const timeout = normalizeTimeoutMs(opts.timeoutMs, DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS);
  const response = respondOrArmObservedDialogOnPage({
    page,
    accept: opts.accept,
    timeoutMs: timeout,
    ...(opts.dialogId !== undefined ? { dialogId: opts.dialogId } : {}),
    ...(opts.promptText !== undefined ? { promptText: opts.promptText } : {}),
    runResponse: async (respond, mode) => {
      const requestSignal = mode === "pending" ? opts.signal : undefined;
      const deadline = new AbortController();
      const deadlineTimer = setTimeout(() => {
        deadline.abort(new Error(`Dialog response timed out after ${timeout}ms`));
      }, timeout);
      const signal = requestSignal
        ? AbortSignal.any([requestSignal, deadline.signal])
        : deadline.signal;
      let responsePending = false;
      let responseFailed = false;
      const { abortPromise, cleanup } = createAbortPromiseWithListener(signal, () => {
        if (responsePending) {
          void forceDisconnectPlaywrightForTarget({
            cdpUrl: opts.cdpUrl,
            targetId: opts.targetId,
            ssrfPolicy: opts.ssrfPolicy,
            reason: "dialog response aborted",
          }).catch(() => {});
        }
      });
      try {
        try {
          return await assertInteractionNavigationCompletedSafely({
            action: async () => {
              responsePending = true;
              try {
                return await awaitActionWithAbort(respond(), abortPromise);
              } catch (err) {
                responseFailed = !signal.aborted;
                throw err;
              } finally {
                responsePending = false;
              }
            },
            cdpUrl: opts.cdpUrl,
            page,
            previousUrl: hasBrowserNavigationPolicy(opts) ? page.url() : "",
            signal,
            targetId: opts.targetId,
            ssrfPolicy: opts.ssrfPolicy,
            browserProxyMode: opts.browserProxyMode,
          });
        } catch (err) {
          if (responseFailed) {
            await forceDisconnectPlaywrightForTarget({
              cdpUrl: opts.cdpUrl,
              targetId: opts.targetId,
              ssrfPolicy: opts.ssrfPolicy,
              reason: "dialog response failed",
            }).catch(() => {});
          }
          throw err;
        }
      } finally {
        clearTimeout(deadlineTimer);
        cleanup();
      }
    },
  });
  if (response.kind === "responding") {
    await response.response;
  }
}

/** Waits for the next page download and writes it under the configured output root. */
export async function waitForDownloadViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    path?: string;
    rootDir?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<BrowserDownloadResult> {
  opts.signal?.throwIfAborted();
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120_000);

  const capture = createExplicitDownloadCapture({
    page,
    state,
    timeoutMs: timeout,
    outPath: opts.path,
    rootDir: opts.path?.trim() ? opts.rootDir : (opts.rootDir ?? resolveImplicitDownloadRoot()),
    ssrfPolicy: opts.ssrfPolicy,
    browserProxyMode: opts.browserProxyMode,
  });
  const { abortPromise, cleanup } = createAbortPromiseWithListener(opts.signal, capture.cancel);
  try {
    return await (abortPromise ? Promise.race([capture.promise, abortPromise]) : capture.promise);
  } catch (err) {
    capture.cancel();
    throw err;
  } finally {
    cleanup();
  }
}

/** Clicks an element ref and saves the download triggered by that click. */
export async function downloadViaPlaywright(
  opts: {
    cdpUrl: string;
    targetId?: string;
    ref: string;
    path: string;
    rootDir?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<BrowserDownloadResult> {
  opts.signal?.throwIfAborted();
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120_000);

  const ref = requireRef(opts.ref);
  const outPath = opts.path?.trim() ?? "";
  if (!outPath) {
    throw new Error("path is required");
  }

  const capture = createExplicitDownloadCapture({
    page,
    state,
    timeoutMs: timeout,
    outPath,
    rootDir: opts.rootDir,
    ssrfPolicy: opts.ssrfPolicy,
    browserProxyMode: opts.browserProxyMode,
  });
  void capture.promise.catch(() => {});
  let clickPending = true;
  const { abortPromise, cleanup } = createAbortPromiseWithListener(opts.signal, () => {
    capture.cancel();
    if (clickPending) {
      void forceDisconnectPlaywrightForTarget({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        ssrfPolicy: opts.ssrfPolicy,
        reason: "download click aborted",
      }).catch(() => {});
    }
  });
  try {
    const locator = refLocator(page, ref);
    try {
      const click = () => {
        opts.signal?.throwIfAborted();
        return awaitActionWithAbort(locator.click({ timeout }), abortPromise).finally(() => {
          clickPending = false;
        });
      };
      await assertInteractionNavigationCompletedSafely({
        action: click,
        cdpUrl: opts.cdpUrl,
        page,
        previousUrl: hasBrowserNavigationPolicy(opts) ? page.url() : "",
        targetId: opts.targetId,
        ssrfPolicy: opts.ssrfPolicy,
        browserProxyMode: opts.browserProxyMode,
      });
    } catch (err) {
      throw toAIFriendlyError(err, ref);
    }
    return await (abortPromise ? Promise.race([capture.promise, abortPromise]) : capture.promise);
  } catch (err) {
    capture.cancel();
    throw err;
  } finally {
    cleanup();
  }
}
