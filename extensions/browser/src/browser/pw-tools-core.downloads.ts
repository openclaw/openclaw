/**
 * File chooser, dialog, and download helpers for Playwright-backed browser
 * tools.
 */
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { Frame, Page } from "playwright-core";
import { isPrivateNetworkAllowedByPolicy } from "../infra/net/ssrf.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { normalizeHostname } from "../sdk-security-runtime.js";
import { DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS } from "./constants.js";
import type { BrowserDownloadCandidate, BrowserDownloadResult } from "./download-types.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed,
  type BrowserNavigationPolicyOptions,
  InvalidBrowserNavigationUrlError,
  parseBrowserNavigationUrl,
} from "./navigation-guard.js";
import { resolveStrictExistingUploadPaths } from "./paths.js";
import { createDownloadCaptureForPage } from "./pw-download-capture.js";
import {
  armObservedDialogResponseOnPage,
  ensurePageState,
  getPageForTargetId,
  refLocator,
  respondToObservedDialogOnPage,
  restoreRoleRefsForTarget,
  withPageNavigationRequestGuard,
} from "./pw-session.js";
import {
  clickViaPlaywright,
  setFileChooserFilesViaPlaywright,
} from "./pw-tools-core.interactions.js";
import {
  awaitActionWithAbort,
  assertInteractionCurrent,
  BrowserInteractionAuthorityError,
  createAbortPromiseWithListener,
  hasInteractionNavigationPolicy,
  interactionNavigationPolicy,
  type InteractionTargetOptions,
  type NavigationTargetOptions,
  runCancellablePageInteraction,
} from "./pw-tools-core.interactions.navigation.js";
import {
  bumpDownloadArmId,
  bumpUploadArmId,
  normalizeTimeoutMs,
  requireRef,
  toAIFriendlyError,
} from "./pw-tools-core.shared.js";

async function dismissFileChooser(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
}

type ActiveUpload = {
  controller: AbortController;
  settled: Promise<void>;
};

const activeUploads = new WeakMap<Page, ActiveUpload>();

function createExplicitDownloadCapture(
  params: BrowserNavigationPolicyOptions & {
    page: Page;
    state: ReturnType<typeof ensurePageState>;
    timeoutMs: number;
    outPath?: string;
    rootDir?: string;
    signal?: AbortSignal;
    beforeSave?: (download: BrowserDownloadCandidate) => Promise<void> | void;
  },
) {
  params.state.armIdDownload = bumpDownloadArmId();
  const armId = params.state.armIdDownload;
  return createDownloadCaptureForPage(params.page, params.state, params.timeoutMs, {
    mode: "explicit",
    outputPath: params.outPath,
    outputRoot: params.rootDir,
    signal: params.signal,
    cancelOnBeforeSaveError: () => params.state.armIdDownload === armId,
    beforeSave: async (download) => {
      if (params.state.armIdDownload !== armId) {
        throw new Error("Download was superseded by another waiter");
      }
      if (params.ssrfPolicy !== undefined || params.browserProxyMode !== undefined) {
        await assertBrowserNavigationResultAllowed({
          url: download.url,
          ssrfPolicy: params.ssrfPolicy,
          browserProxyMode: params.browserProxyMode,
          signal: params.signal,
        });
      }
      await params.beforeSave?.(download);
      if (params.state.armIdDownload !== armId) {
        throw new Error("Download was superseded by another waiter");
      }
    },
  });
}

function resolveImplicitDownloadRoot(): string {
  return path.join(resolvePreferredOpenClawTmpDir(), "downloads");
}

type UploadOptions = NavigationTargetOptions & {
  ref?: string;
  paths?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
};

async function runFileUpload(opts: UploadOptions): Promise<void> {
  opts.signal?.throwIfAborted();
  const atomic = opts.ref !== undefined;
  const armId = bumpUploadArmId();
  const timeout = normalizeTimeoutMs(opts.timeoutMs, DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS);
  const controller = new AbortController();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, controller.signal])
    : controller.signal;
  const { abortPromise, cleanup } = createAbortPromiseWithListener(signal);
  const armed = createDeferred<void>();
  let started = false;
  let deadline = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startDeadline = () => {
    deadline = Date.now() + timeout;
    timer = setTimeout(
      () =>
        controller.abort(new Error(`Timeout ${timeout}ms exceeded while completing file upload`)),
      timeout,
    );
  };
  if (atomic) {
    startDeadline();
  }
  const completion = (async () => {
    const page = await awaitActionWithAbort(getPageForTargetId(opts), abortPromise);
    signal.throwIfAborted();
    if (opts.assertCurrent) {
      await assertInteractionCurrent(opts);
      signal.throwIfAborted();
    }
    const state = ensurePageState(page);
    // Page lookup may finish out of order. Only a newer request can replace
    // this page's owner; unrelated tabs share no chooser or cleanup queue.
    if (state.armIdUpload > armId) {
      throw new Error("File upload was superseded by another waiter");
    }
    state.armIdUpload = armId;
    const previous = activeUploads.get(page);
    const execution = Promise.resolve().then(async () => {
      // A cancelled queued caller may return early, but its successor must
      // still join every older native action before installing a new waiter.
      await previous?.settled;
      signal.throwIfAborted();
      if (opts.assertCurrent) {
        await assertInteractionCurrent(opts);
        signal.throwIfAborted();
      }
      started = true;
      if (!atomic) {
        startDeadline();
      }
      const chooser = page.waitForEvent("filechooser", { timeout: 0, signal });
      void chooser.catch(() => {});
      // Accepted passive arms own future completion after their requesting
      // invocation ends; only atomic uploads retain its authority callback.
      const completionOptions = atomic ? opts : { ...opts, assertCurrent: undefined };
      armed.resolve();
      let chooserAcquired = false;
      try {
        if (atomic) {
          await clickViaPlaywright({
            ...opts,
            ref: opts.ref!,
            timeoutMs: Math.max(1, deadline - Date.now()),
            resolvedPage: page,
            signal,
          });
        }
        const fileChooser = await chooser;
        chooserAcquired = true;
        signal.throwIfAborted();
        let paths = opts.paths ?? [];
        if (!atomic) {
          const resolved = await awaitActionWithAbort(
            resolveStrictExistingUploadPaths({ requestedPaths: paths }),
            abortPromise,
          );
          signal.throwIfAborted();
          if (!paths.length || !resolved.ok) {
            await dismissFileChooser(page);
            return;
          }
          paths = resolved.paths;
        }
        await setFileChooserFilesViaPlaywright({
          ...completionOptions,
          page,
          fileChooser,
          paths,
          timeoutMs: Math.max(1, deadline - Date.now()),
          signal,
        });
        signal.throwIfAborted();
      } catch (error) {
        controller.abort(error);
        if (chooserAcquired && error instanceof BrowserInteractionAuthorityError) {
          await dismissFileChooser(page);
        }
        if (
          error instanceof Error &&
          error.name === "AbortError" &&
          error.cause === signal.reason
        ) {
          signal.throwIfAborted();
        }
        throw error;
      } finally {
        await chooser.catch(() => {});
      }
    });
    const active = {
      controller,
      settled: execution.then(
        () => {},
        () => {},
      ),
    };
    activeUploads.set(page, active);
    previous?.controller.abort(new Error("File upload was superseded by another waiter"));
    try {
      await execution;
    } finally {
      if (activeUploads.get(page) === active) {
        activeUploads.delete(page);
      }
    }
  })().finally(() => {
    clearTimeout(timer);
    cleanup();
  });
  // Passive arming intentionally outlives this call; its errors are contained.
  void completion.catch(() => {});
  try {
    await awaitActionWithAbort(
      atomic ? completion : Promise.race([armed.promise, completion]),
      abortPromise,
    );
  } catch (error) {
    if (atomic && started) {
      await completion;
    }
    throw error;
  }
}

/** Arms the next page file chooser and fills it with strict existing paths. */
export async function armFileUploadViaPlaywright(
  opts: Omit<UploadOptions, "ref" | "signal">,
): Promise<void> {
  await runFileUpload(opts);
}

/** Clicks a ref and completes its file chooser as one request-owned operation. */
export async function uploadViaPlaywright(
  opts: UploadOptions & { ref: string; paths: string[] },
): Promise<void> {
  await runFileUpload(opts);
}

/** Accepts or dismisses a pending dialog, or arms the next matching dialog response. */
export async function armDialogViaPlaywright(
  opts: InteractionTargetOptions & {
    dialogId?: string;
    accept: boolean;
    promptText?: string;
    timeoutMs?: number;
  },
): Promise<void> {
  const page = await getPageForTargetId(opts);
  const timeout = normalizeTimeoutMs(opts.timeoutMs, DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS);
  if (opts.assertCurrent) {
    await assertInteractionCurrent(opts);
  }
  try {
    await respondToObservedDialogOnPage({
      page,
      accept: opts.accept,
      closedBy: "agent",
      ...(opts.dialogId !== undefined ? { dialogId: opts.dialogId } : {}),
      ...(opts.promptText !== undefined ? { promptText: opts.promptText } : {}),
    });
    return;
  } catch (err) {
    if (opts.dialogId || (err instanceof Error && !err.message.includes("No dialog is pending"))) {
      throw err;
    }
  }

  if (opts.assertCurrent) {
    await assertInteractionCurrent(opts);
  }
  armObservedDialogResponseOnPage({
    page,
    accept: opts.accept,
    timeoutMs: timeout,
    ...(opts.promptText !== undefined ? { promptText: opts.promptText } : {}),
  });
}

/** Waits for the next page download and writes it under the configured output root. */
export async function waitForDownloadViaPlaywright(
  opts: NavigationTargetOptions & {
    path?: string;
    rootDir?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<BrowserDownloadResult> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120_000);
  const navigationPolicy = interactionNavigationPolicy(opts);
  const policyDenial = new AbortController();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, policyDenial.signal])
    : policyDenial.signal;
  const waitForCapture = async () => {
    if (opts.assertCurrent) {
      await assertInteractionCurrent(opts);
    }
    const capture = createExplicitDownloadCapture({
      page,
      state,
      timeoutMs: timeout,
      outPath: opts.path,
      rootDir: opts.path?.trim() ? opts.rootDir : (opts.rootDir ?? resolveImplicitDownloadRoot()),
      signal,
      ...navigationPolicy,
    });
    return await capture.promise;
  };
  if (!hasInteractionNavigationPolicy(navigationPolicy)) {
    return await waitForCapture();
  }
  return await withPageNavigationRequestGuard({
    page,
    ...navigationPolicy,
    onPolicyDenied: (event) => {
      if (event.state === "detected") {
        policyDenial.abort(
          event.error instanceof Error
            ? event.error
            : new Error("Browser navigation blocked by policy", { cause: event.error }),
        );
      }
    },
    action: waitForCapture,
  });
}

/** Clicks an element ref and saves the download triggered by that click. */
export async function downloadViaPlaywright(
  opts: NavigationTargetOptions & {
    ref: string;
    path: string;
    rootDir?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<BrowserDownloadResult> {
  const page = await getPageForTargetId(opts);
  if (opts.assertCurrent) {
    await assertInteractionCurrent(opts);
  }
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
    signal: opts.signal,
    ssrfPolicy: opts.ssrfPolicy,
    browserProxyMode: opts.browserProxyMode,
  });
  void capture.promise.catch(() => {});
  try {
    const locator = refLocator(page, ref);
    await runCancellablePageInteraction(
      page,
      opts,
      async (signal) => await locator.click({ timeout, signal }),
      ref,
    );
  } catch (err) {
    capture.cancel();
    throw opts.signal?.aborted && opts.signal.reason instanceof Error
      ? opts.signal.reason
      : toAIFriendlyError(err, ref);
  }
  return await capture.promise;
}

/** Save the displayed document using its browser session without navigating its preview. */
export async function downloadCurrentDocumentViaPlaywright(
  opts: NavigationTargetOptions & {
    expectedUrl: string;
    rootDir?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<BrowserDownloadResult> {
  opts.signal?.throwIfAborted();
  const expectedUrl = opts.expectedUrl;
  const parsed = parseBrowserNavigationUrl(expectedUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidBrowserNavigationUrlError("Only HTTP(S) documents can be downloaded");
  }
  // Chromium hides native download redirect requests from page.route. A starting
  // host's trust does not authorize the next host, and save-time checks are too late.
  // Shared policy normalization treats blank/lone-wildcard entries as unconstrained.
  const hasHostnameRestrictions = [
    ...(opts.ssrfPolicy?.hostnameAllowlist ?? []),
    ...(opts.ssrfPolicy?.blockedHostnames ?? []),
  ].some((pattern) => {
    const normalized = normalizeHostname(pattern);
    return normalized.length > 0 && normalized !== "*";
  });
  if (!isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy) || hasHostnameRestrictions) {
    throw new InvalidBrowserNavigationUrlError(
      "Current-document downloads are unavailable under this browser network policy because download redirects cannot be inspected",
    );
  }
  const operation = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, operation.signal]) : operation.signal;
  const { abortPromise, cleanup } = createAbortPromiseWithListener(signal);
  let page: Page | undefined;
  const changedError = () => new Error("The tab changed before its download completed. Try again.");
  const assertCurrentDocument = () => {
    signal.throwIfAborted();
    if (!page || page.isClosed() || page.url() !== expectedUrl) {
      throw changedError();
    }
  };
  const onClose = () => operation.abort(changedError());
  const onNavigation = (frame: Frame) => {
    if (frame === page?.mainFrame()) {
      operation.abort(changedError());
    }
  };
  try {
    page = await awaitActionWithAbort(getPageForTargetId(opts), abortPromise);
    page.on("close", onClose);
    page.on("framenavigated", onNavigation);
    assertCurrentDocument();
    await awaitActionWithAbort(
      assertBrowserNavigationAllowed({
        url: page.url(),
        ssrfPolicy: opts.ssrfPolicy,
        browserProxyMode: opts.browserProxyMode,
        signal,
      }),
      abortPromise,
    );
    assertCurrentDocument();
    if (opts.assertCurrent) {
      await assertInteractionCurrent(opts);
      assertCurrentDocument();
    }
    const timeout = normalizeTimeoutMs(opts.timeoutMs, DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS);
    const capture = createExplicitDownloadCapture({
      page,
      state: ensurePageState(page),
      timeoutMs: timeout,
      rootDir: opts.rootDir ?? resolveImplicitDownloadRoot(),
      signal,
      beforeSave: async (download) => {
        try {
          assertCurrentDocument();
          await assertBrowserNavigationAllowed({
            url: download.url,
            ssrfPolicy: opts.ssrfPolicy,
            browserProxyMode: opts.browserProxyMode,
            signal,
          });
          assertCurrentDocument();
        } catch (error) {
          operation.abort(error);
          throw error;
        }
      },
    });
    void capture.promise.catch(() => {});
    try {
      assertCurrentDocument();
      const trigger = page.evaluate(
        ({ expectedUrl: documentUrl, deadline }) => {
          if (location.href !== documentUrl || Date.now() >= deadline) {
            throw new Error("The tab changed before its download started. Try again.");
          }
          // The browser owns cookies, streaming and Content-Disposition. A detached,
          // same-origin download link leaves the inline document and its playback intact.
          const anchor = document.createElement("a");
          anchor.href = location.href;
          anchor.download = "";
          anchor.click();
        },
        { expectedUrl, deadline: Date.now() + timeout },
      );
      await Promise.race([trigger, capture.promise]);
      return await capture.promise;
    } catch (error) {
      operation.abort(error);
      throw error;
    }
  } finally {
    page?.off("close", onClose);
    page?.off("framenavigated", onNavigation);
    cleanup();
  }
}
