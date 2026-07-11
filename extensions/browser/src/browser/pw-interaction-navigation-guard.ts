import type { Frame, Page } from "playwright-core";
import {
  assertBrowserNavigationResultAllowed,
  type BrowserNavigationPolicyOptions,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import {
  assertPageNavigationCompletedSafely,
  finalizePendingBrowserInteractionAction,
  forceDisconnectPlaywrightForTarget,
  isPolicyDenyNavigationError,
  quarantineBlockedNavigationTargetForError,
  replacePendingBrowserInteractionActionError,
  trackPendingBrowserInteractionAction,
  wasBrowserNavigationRequestBlockedBeforeDispatch,
  withPageNavigationRequestGuard,
} from "./pw-session.js";

export { assertBrowserDownloadSaveAllowed } from "./pw-download-navigation-policy.js";

export const INTERACTION_NAVIGATION_GRACE_MS = 250;
const INTERACTION_MAX_OBSERVED_FRAME_URLS = 256;

class InteractionNavigationObservationOverflowError extends Error {
  constructor() {
    super("Too many frame navigations occurred to verify the interaction safely");
    this.name = "InteractionNavigationObservationOverflowError";
  }
}

/** Return true when continuing a batch could operate past a failed navigation boundary. */
export function isBrowserInteractionNavigationSecurityError(err: unknown): boolean {
  return (
    isPolicyDenyNavigationError(err) || err instanceof InteractionNavigationObservationOverflowError
  );
}

type NavigationObservablePage = Pick<Page, "url"> & {
  mainFrame?: () => Frame;
  on?: (event: "framenavigated", listener: (frame: Frame) => void) => unknown;
  off?: (event: "framenavigated", listener: (frame: Frame) => void) => unknown;
};

type ObservedInteractionNavigations = {
  mainFrameNavigated: boolean;
  frameUrls: readonly string[];
  overflowed: boolean;
};

export function hasBrowserNavigationPolicy(opts: BrowserNavigationPolicyOptions): boolean {
  return Boolean(opts.ssrfPolicy || opts.browserProxyMode === "explicit-browser-proxy");
}

// A fragment-only mutation does not cross the network boundary. An exact same
// URL paired with framenavigated is a reload/form submit and must stay guarded.
function isHashOnlyNavigation(currentUrl: string, previousUrl: string): boolean {
  if (currentUrl === previousUrl) {
    return false;
  }
  try {
    const previous = new URL(previousUrl);
    const current = new URL(currentUrl);
    return (
      previous.origin === current.origin &&
      previous.pathname === current.pathname &&
      previous.search === current.search
    );
  } catch {
    return false;
  }
}

function didCrossDocumentUrlChange(page: { url(): string }, previousUrl: string): boolean {
  const currentUrl = page.url();
  return currentUrl !== previousUrl && !isHashOnlyNavigation(currentUrl, previousUrl);
}

function isMainFrameNavigation(page: NavigationObservablePage, frame: Frame): boolean {
  return typeof page.mainFrame !== "function" || frame === page.mainFrame();
}

function snapshotNetworkFrameUrl(frame: Frame): string | null {
  try {
    const frameUrl = frame.url();
    return frameUrl.startsWith("http://") || frameUrl.startsWith("https://") ? frameUrl : null;
  } catch {
    return null;
  }
}

async function assertObservedFrameNavigationAllowed(
  frameUrl: string,
  navigationPolicy: BrowserNavigationPolicyOptions,
): Promise<void> {
  if (
    !hasBrowserNavigationPolicy(navigationPolicy) ||
    (!frameUrl.startsWith("http://") && !frameUrl.startsWith("https://"))
  ) {
    return;
  }
  await assertBrowserNavigationResultAllowed({
    url: frameUrl,
    ...withBrowserNavigationPolicy(navigationPolicy.ssrfPolicy, {
      browserProxyMode: navigationPolicy.browserProxyMode,
    }),
  });
}

async function assertObservedInteractionNavigations(
  opts: {
    cdpUrl: string;
    page: Page;
    targetId?: string;
    observed: ObservedInteractionNavigations;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  let frameError: unknown;
  for (const frameUrl of opts.observed.frameUrls) {
    try {
      await assertObservedFrameNavigationAllowed(frameUrl, opts);
    } catch (err) {
      if (
        !frameError ||
        (!isPolicyDenyNavigationError(frameError) && isPolicyDenyNavigationError(err))
      ) {
        frameError = err;
      }
    }
  }
  if (opts.observed.overflowed && !isPolicyDenyNavigationError(frameError)) {
    frameError = new InteractionNavigationObservationOverflowError();
  }

  let finalError: unknown;
  if (opts.observed.mainFrameNavigated) {
    try {
      await assertPageNavigationCompletedSafely({
        cdpUrl: opts.cdpUrl,
        page: opts.page,
        response: null,
        ssrfPolicy: opts.ssrfPolicy,
        browserProxyMode: opts.browserProxyMode,
        targetId: opts.targetId,
      });
    } catch (err) {
      finalError = err;
    }
  }

  const preferredError = isPolicyDenyNavigationError(frameError)
    ? frameError
    : isPolicyDenyNavigationError(finalError)
      ? finalError
      : frameError instanceof InteractionNavigationObservationOverflowError
        ? frameError
        : (finalError ?? frameError);
  if (
    preferredError === frameError &&
    isPolicyDenyNavigationError(preferredError) &&
    !isPolicyDenyNavigationError(finalError)
  ) {
    // A request-time denial may return before its Playwright action settles.
    // Quarantine committed frame violations here so that detached post-check
    // failures cannot be swallowed by the pending-action owner.
    await quarantineBlockedNavigationTargetForError({
      cdpUrl: opts.cdpUrl,
      error: preferredError,
      page: opts.page,
      targetId: opts.targetId,
    });
  }
  if (preferredError) {
    throw toError(preferredError, "Non-Error thrown");
  }
}

async function runInteractionWithPostNavigationCheck<T>(
  opts: {
    action: () => Promise<T>;
    allowUnchangedCurrentPageUrlForResize?: boolean;
    cdpUrl: string;
    page: Page;
    previousUrl: string;
    signal?: AbortSignal;
    targetId?: string;
  } & BrowserNavigationPolicyOptions,
): Promise<T> {
  if (!hasBrowserNavigationPolicy(opts)) {
    return await opts.action();
  }

  // One observer spans the action plus its full grace window. Settling on the
  // first safe navigation would let a delayed second destination escape.
  const navPage = opts.page as NavigationObservablePage;
  let mainFrameNavigated = false;
  let lastMainFrameUrl = opts.previousUrl;
  let overflowed = false;
  const frameUrls = new Set<string>();
  const recordFrameUrl = (url: string) => {
    if ((!url.startsWith("http://") && !url.startsWith("https://")) || frameUrls.has(url)) {
      return;
    }
    if (frameUrls.size >= INTERACTION_MAX_OBSERVED_FRAME_URLS) {
      overflowed = true;
      return;
    }
    frameUrls.add(url);
  };
  const onFrameNavigated = (frame: Frame) => {
    if (!isMainFrameNavigation(navPage, frame)) {
      const frameUrl = snapshotNetworkFrameUrl(frame);
      if (frameUrl) {
        recordFrameUrl(frameUrl);
      }
      return;
    }
    const currentUrl = opts.page.url();
    if (!isHashOnlyNavigation(currentUrl, lastMainFrameUrl)) {
      mainFrameNavigated = true;
      recordFrameUrl(currentUrl);
    }
    lastMainFrameUrl = currentUrl;
  };
  if (typeof navPage.on === "function") {
    navPage.on("framenavigated", onFrameNavigated);
  }
  let observerAttached = typeof navPage.on === "function";
  const stopObserving = () => {
    if (!observerAttached) {
      return;
    }
    observerAttached = false;
    if (typeof navPage.off === "function") {
      navPage.off("framenavigated", onFrameNavigated);
    }
  };
  const waitForGrace = async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, INTERACTION_NAVIGATION_GRACE_MS);
    });
  };
  const runPostflight = async () => {
    mainFrameNavigated ||= didCrossDocumentUrlChange(opts.page, opts.previousUrl);
    if (mainFrameNavigated || frameUrls.size > 0 || overflowed) {
      await assertObservedInteractionNavigations({
        cdpUrl: opts.cdpUrl,
        page: opts.page,
        ssrfPolicy: opts.ssrfPolicy,
        browserProxyMode: opts.browserProxyMode,
        targetId: opts.targetId,
        observed: { mainFrameNavigated, frameUrls: [...frameUrls], overflowed },
      });
    }
  };

  let actionSucceeded = false;
  let result: T | undefined;
  let actionError: unknown;
  try {
    result = await opts.action();
    actionSucceeded = true;
  } catch (err) {
    actionError = err;
  }

  if (!actionSucceeded) {
    const pending = finalizePendingBrowserInteractionAction(actionError, async () => {
      try {
        await waitForGrace();
        await runPostflight();
      } catch (err) {
        // The caller already received its abort/dialog error. Fail closed on a
        // detached postflight instead of losing a later navigation violation.
        await quarantineBlockedNavigationTargetForError({
          cdpUrl: opts.cdpUrl,
          error: err,
          page: opts.page,
          targetId: opts.targetId,
        }).catch(() => {});
      } finally {
        stopObserving();
      }
    });
    if (pending.deferred) {
      throw pending.error;
    }
  }

  try {
    await waitForGrace();
  } finally {
    stopObserving();
  }

  try {
    await runPostflight();
  } catch (err) {
    throw replacePendingBrowserInteractionActionError(
      actionSucceeded ? undefined : actionError,
      err,
    );
  }

  if (!actionSucceeded) {
    throw toError(actionError, "Non-Error thrown");
  }
  return result as T;
}

/** Run one Playwright page action under the bounded selected-page navigation guard. */
export async function assertInteractionNavigationCompletedSafely<T>(
  opts: {
    action: () => Promise<T>;
    allowUnchangedCurrentPageUrlForResize?: boolean;
    cdpUrl: string;
    page: Page;
    previousUrl: string;
    signal?: AbortSignal;
    targetId?: string;
  } & BrowserNavigationPolicyOptions,
): Promise<T> {
  try {
    return await withPageNavigationRequestGuard({
      page: opts.page,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      onGuardCleanupError: async () =>
        await forceDisconnectPlaywrightForTarget({
          cdpUrl: opts.cdpUrl,
          targetId: opts.targetId,
          ssrfPolicy: opts.ssrfPolicy,
          reason: "navigation guard cleanup failed",
        }),
      onLateUnsafePolicyError: async (err) =>
        await quarantineBlockedNavigationTargetForError({
          cdpUrl: opts.cdpUrl,
          error: err,
          page: opts.page,
          targetId: opts.targetId,
        }),
      action: async () => {
        let actionBaselineUrl = hasBrowserNavigationPolicy(opts)
          ? opts.page.url()
          : opts.previousUrl;
        if (hasBrowserNavigationPolicy(opts) && !opts.allowUnchangedCurrentPageUrlForResize) {
          const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy, {
            browserProxyMode: opts.browserProxyMode,
          });
          await assertBrowserNavigationResultAllowed({
            url: actionBaselineUrl,
            ...navigationPolicy,
          });
          // A route is already installed, so a navigation racing the async
          // policy check is intercepted. Still baseline the latest allowed URL.
          const latestUrl = opts.page.url();
          if (latestUrl !== actionBaselineUrl) {
            await assertBrowserNavigationResultAllowed({ url: latestUrl, ...navigationPolicy });
            actionBaselineUrl = latestUrl;
          }
        }
        return await runInteractionWithPostNavigationCheck({
          ...opts,
          action: async () => {
            opts.signal?.throwIfAborted();
            return await opts.action();
          },
          previousUrl: actionBaselineUrl,
        });
      },
    });
  } catch (err) {
    if (
      isBrowserInteractionNavigationSecurityError(err) &&
      !wasBrowserNavigationRequestBlockedBeforeDispatch(err)
    ) {
      await quarantineBlockedNavigationTargetForError({
        cdpUrl: opts.cdpUrl,
        error: err,
        page: opts.page,
        targetId: opts.targetId,
      });
    }
    throw err;
  }
}

export async function awaitActionWithAbort<T>(
  actionPromise: Promise<T>,
  abortPromise?: Promise<never>,
  onActionResolvedAfterAbort?: () => void,
): Promise<T> {
  if (!abortPromise) {
    return await actionPromise;
  }
  const outcome = await Promise.race([
    actionPromise.then(
      (value) => ({ kind: "action-result" as const, value }),
      (error: unknown) => ({ kind: "action-error" as const, error }),
    ),
    abortPromise.then(
      () => ({ kind: "abort-result" as const }),
      (error: unknown) => ({ kind: "abort-error" as const, error }),
    ),
  ]);
  if (outcome.kind === "action-result") {
    return outcome.value;
  }
  if (outcome.kind === "action-error") {
    throw outcome.error;
  }
  if (outcome.kind === "abort-error") {
    throw trackPendingBrowserInteractionAction(
      outcome.error,
      actionPromise,
      onActionResolvedAfterAbort,
    );
  }
  throw new Error("abort signal resolved unexpectedly");
}

export function createAbortPromise(signal?: AbortSignal): {
  abortPromise?: Promise<never>;
  cleanup: () => void;
} {
  return createAbortPromiseWithListener(signal);
}

export function createAbortPromiseWithListener(
  signal?: AbortSignal,
  onAbort?: (reason: unknown) => void,
): {
  abortPromise?: Promise<never>;
  cleanup: () => void;
} {
  if (!signal) {
    return { cleanup: () => {} };
  }
  let abortListener: (() => void) | undefined;
  const abortPromise: Promise<never> = signal.aborted
    ? (() => {
        onAbort?.(signal.reason);
        return Promise.reject(
          toError(signal.reason ?? new Error("aborted"), "Non-Error rejection"),
        );
      })()
    : new Promise((_, reject) => {
        abortListener = () => {
          onAbort?.(signal.reason);
          reject(toError(signal.reason ?? new Error("aborted"), "Non-Error rejection"));
        };
        signal.addEventListener("abort", abortListener, { once: true });
      });
  void abortPromise.catch(() => {});
  return {
    abortPromise,
    cleanup: () => {
      if (abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    },
  };
}

/** Run one abortable Playwright page operation under the canonical navigation guard. */
export async function runGuardedPlaywrightPageAction<T>(
  opts: {
    action: () => Promise<T>;
    cdpUrl: string;
    page: Page;
    signal?: AbortSignal;
    targetId?: string;
  } & BrowserNavigationPolicyOptions,
): Promise<T> {
  opts.signal?.throwIfAborted();
  const { abortPromise, cleanup } = createAbortPromise(opts.signal);
  try {
    return await assertInteractionNavigationCompletedSafely({
      action: () =>
        awaitActionWithAbort(
          Promise.resolve().then(async () => {
            opts.signal?.throwIfAborted();
            return await opts.action();
          }),
          abortPromise,
        ),
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      previousUrl: "",
      signal: opts.signal,
      targetId: opts.targetId,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
    });
  } finally {
    cleanup();
  }
}

function toError(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
