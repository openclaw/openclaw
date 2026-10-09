import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/retry-runtime";
import type { Frame, Page } from "playwright-core";
import {
  BROWSER_ACTION_NAVIGATION_GRACE_MS,
  normalizeActBoundedNonNegativeMs,
} from "./act-policy.js";
import {
  assertBrowserNavigationResultAllowed,
  type BrowserNavigationPolicyOptions,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import {
  assertPageNavigationCompletedSafely,
  getPageForTargetId,
  isBrowserObservedDialogBlockedError,
  isPolicyDenyNavigationError,
  markObservedDialogsHandledRemotelyForPage,
  quarantineBlockedNavigationTarget,
  restoreRoleRefsForTarget,
  wasBrowserNavigationSourcePreservedAfterPolicyDenial,
  withPageNavigationRequestGuard,
} from "./pw-session.js";
import { toAIFriendlyError } from "./pw-tools-core.shared.js";

export type InteractionTargetOptions = {
  cdpUrl: string;
  browserFilesystemLocal?: boolean;
  /**
   * Extension-backed uploads take the byte-payload branch because Store-installed
   * extensions cannot read gateway-local paths, but the user's browser still runs
   * on this machine. At or above the relay-safe payload bound (files whose base64
   * form would not fit a single extension-relay WebSocket message), keep the local
   * path handoff that file-access extensions accept instead of rejecting the upload.
   */
  uploadPathsFallbackOnPayloadLimit?: boolean;
  targetId?: string;
  assertCurrent?: () => void | Promise<void>;
};

export type NavigationTargetOptions = InteractionTargetOptions & BrowserNavigationPolicyOptions;
export type GuardedInteractionOptions = NavigationTargetOptions & { signal?: AbortSignal };
export type ElementInteractionOptions = GuardedInteractionOptions & {
  ref?: string;
  selector?: string;
  timeoutMs?: number;
};

export class BrowserInteractionAuthorityError extends Error {
  constructor(error: unknown) {
    const cause = toErrorObject(error, "Browser interaction authority changed");
    super(cause.message, { cause });
    this.name = "BrowserInteractionAuthorityError";
  }
}

export function assertInteractionCurrent(
  opts: Pick<InteractionTargetOptions, "assertCurrent">,
): void | Promise<void> {
  const reject = (error: unknown): never => {
    // Authority loss is fatal even inside a batch configured to continue on errors.
    throw new BrowserInteractionAuthorityError(error);
  };
  try {
    // Preserve a resident assertion's synchronous fence through native action dispatch.
    const assertion = opts.assertCurrent?.();
    return assertion ? assertion.catch(reject) : undefined;
  } catch (error) {
    reject(error);
  }
}

export function interactionNavigationPolicy(
  opts: BrowserNavigationPolicyOptions,
): BrowserNavigationPolicyOptions {
  return withBrowserNavigationPolicy(opts.ssrfPolicy, {
    browserProxyMode: opts.browserProxyMode,
  });
}

export function hasInteractionNavigationPolicy(policy: BrowserNavigationPolicyOptions): boolean {
  return Boolean(policy.ssrfPolicy || policy.browserProxyMode);
}

type NavigationObservablePage = Pick<Page, "url" | "mainFrame" | "on" | "off">;

const pendingInteractionNavigationGuardCleanup = new WeakMap<Page, () => void>();

export function resolveBoundedDelayMs(
  value: number | undefined,
  label: string,
  maxMs: number,
): number {
  return normalizeActBoundedNonNegativeMs(Math.floor(value ?? 0), label, maxMs) ?? 0;
}

export async function getRestoredPageForTarget(opts: InteractionTargetOptions) {
  const page = await getPageForTargetId(opts);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  return page;
}

export function toFriendlyInteractionError(err: unknown, label: string): Error {
  return isBrowserObservedDialogBlockedError(err) || err instanceof BrowserInteractionAuthorityError
    ? err
    : toAIFriendlyError(err, label);
}

export function reconcileRemoteDialogAfterActionSettled(page: Page, signal?: AbortSignal): void {
  if (isBrowserObservedDialogBlockedError(signal?.reason)) {
    markObservedDialogsHandledRemotelyForPage(page, signal.reason.browserState.dialogs.pending);
  }
}

export function throwIfInteractionAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw toErrorObject(signal.reason ?? new Error("aborted"), "Non-Error rejection");
  }
}

export async function runCancellablePageInteraction<T>(
  page: Page,
  opts: GuardedInteractionOptions,
  action: (signal: AbortSignal) => Promise<T>,
  errorLabel?: string,
): Promise<T> {
  const cancellation = new AbortController();
  const interruption = new AbortController();
  const onAbort = () => {
    // Dialogs interrupt the foreground call while the native action and its
    // navigation guard remain live. Caller cancellation must join the native call.
    const controller = isBrowserObservedDialogBlockedError(opts.signal?.reason)
      ? interruption
      : cancellation;
    controller.abort(opts.signal?.reason);
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) {
    onAbort();
  }
  const { abortPromise, cleanup } = createAbortPromiseWithListener(interruption.signal);
  try {
    const result = await awaitNavigationGuardedInteraction(
      {
        action: () => action(cancellation.signal),
        cdpUrl: opts.cdpUrl,
        page,
        ...interactionNavigationPolicy(opts),
        targetId: opts.targetId,
        assertCurrent: opts.assertCurrent,
      },
      abortPromise,
      opts.signal,
      () => reconcileRemoteDialogAfterActionSettled(page, opts.signal),
    );
    throwIfInteractionAborted(opts.signal);
    return result;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "AbortError" &&
      error.cause === cancellation.signal.reason
    ) {
      throwIfInteractionAborted(cancellation.signal);
    }
    throw errorLabel === undefined ? error : toFriendlyInteractionError(error, errorLabel);
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    cleanup();
  }
}

// Returns true only when the URL change indicates a cross-document navigation
// (i.e., a real network fetch occurred). Same-document hash-only mutations —
// anchor clicks and history.pushState/replaceState that change only the
// fragment — do not cause a network request and must not trigger SSRF checks.
function didCrossDocumentUrlChange(page: { url(): string }, previousUrl: string): boolean {
  const currentUrl = page.url();
  return currentUrl !== previousUrl && !isHashOnlyNavigation(currentUrl, previousUrl);
}

// Returns true when a framenavigated event represents only a hash-only
// same-document mutation (no network request). Used in event-driven checks
// where the event itself is the navigation signal — unlike URL polling, we
// cannot use identical URLs as a "no navigation" sentinel because same-URL
// reloads and form submits also fire framenavigated with an unchanged URL.
function isHashOnlyNavigation(currentUrl: string, previousUrl: string): boolean {
  if (currentUrl === previousUrl) {
    // Exact same URL + framenavigated firing = reload or form submit, not a
    // fragment hop. Must run SSRF checks.
    return false;
  }
  const prev = URL.parse(previousUrl);
  const curr = URL.parse(currentUrl);
  return Boolean(
    prev &&
    curr &&
    prev.origin === curr.origin &&
    prev.pathname === curr.pathname &&
    prev.search === curr.search,
  );
}

type ObservedDelayedNavigations = {
  mainFrameNavigated: boolean;
  subframes: string[];
};

function createInteractionFrameListener(
  page: NavigationObservablePage,
  previousUrl: string,
  subframes: string[],
  onMainFrameNavigation: () => void,
): (frame: Frame) => void {
  return (frame) => {
    if (frame !== page.mainFrame()) {
      const frameUrl = frame.url();
      if (frameUrl.startsWith("http://") || frameUrl.startsWith("https://")) {
        subframes.push(frameUrl);
      }
    } else if (!isHashOnlyNavigation(page.url(), previousUrl)) {
      // The event itself proves navigation, including same-URL reloads.
      onMainFrameNavigation();
    }
  };
}

async function assertObservedInteractionNavigations(
  opts: {
    cdpUrl: string;
    page: Page;
    targetId?: string;
    observed: ObservedDelayedNavigations;
  } & BrowserNavigationPolicyOptions,
  onNoMainFrameNavigation?: () => Promise<void>,
): Promise<void> {
  const navigationPolicy = interactionNavigationPolicy(opts);
  let subframeError: unknown;
  try {
    for (const frameUrl of opts.observed.subframes) {
      await assertBrowserNavigationResultAllowed({ url: frameUrl, ...navigationPolicy });
    }
  } catch (err) {
    subframeError = err;
  }
  if (opts.observed.mainFrameNavigated) {
    await assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      response: null,
      ...navigationPolicy,
      targetId: opts.targetId,
    });
  } else if (onNoMainFrameNavigation) {
    await onNoMainFrameNavigation();
  }
  if (subframeError) {
    throw toErrorObject(subframeError, "Non-Error thrown");
  }
}

function observeDelayedInteractionNavigation(
  page: Page,
  previousUrl: string,
  replacePending = false,
): Promise<ObservedDelayedNavigations | undefined> {
  if (didCrossDocumentUrlChange(page, previousUrl)) {
    return Promise.resolve({ mainFrameNavigated: true, subframes: [] });
  }
  if (replacePending) {
    pendingInteractionNavigationGuardCleanup.get(page)?.();
  }

  return new Promise((resolve) => {
    const subframes: string[] = [];
    const settle = (mainFrameNavigated: boolean) => {
      cleanup();
      resolve({ mainFrameNavigated, subframes });
    };
    const cancel = () => {
      cleanup();
      resolve(undefined);
    };
    const onFrameNavigated = createInteractionFrameListener(page, previousUrl, subframes, () =>
      settle(true),
    );
    const timeout = setTimeout(
      () => settle(didCrossDocumentUrlChange(page, previousUrl)),
      BROWSER_ACTION_NAVIGATION_GRACE_MS,
    );
    const cleanup = () => {
      clearTimeout(timeout);
      page.off("framenavigated", onFrameNavigated);
      if (pendingInteractionNavigationGuardCleanup.get(page) === cancel) {
        pendingInteractionNavigationGuardCleanup.delete(page);
      }
    };
    if (replacePending) {
      pendingInteractionNavigationGuardCleanup.set(page, cancel);
    }
    page.on("framenavigated", onFrameNavigated);
  });
}

async function assertInteractionNavigationCompletedSafely<T>(
  opts: {
    action: () => Promise<T>;
    cdpUrl: string;
    page: Page;
    previousUrl: string;
    targetId?: string;
  } & BrowserNavigationPolicyOptions,
): Promise<T> {
  const navigationPolicy = interactionNavigationPolicy(opts);
  if (!hasInteractionNavigationPolicy(navigationPolicy)) {
    return await opts.action();
  }
  // Phase 1: keep a framenavigated listener alive for the entire duration of the
  // action so navigations triggered mid-click or mid-evaluate are not missed.
  // Using a fixed pre-action timer would expire before the action finishes for
  // slow interactions, silently bypassing the SSRF guard.
  let navigatedDuringAction = false;
  const subframeNavigationsDuringAction: string[] = [];
  const onFrameNavigated = createInteractionFrameListener(
    opts.page,
    opts.previousUrl,
    subframeNavigationsDuringAction,
    () => {
      navigatedDuringAction = true;
    },
  );
  opts.page.on("framenavigated", onFrameNavigated);

  let result: T | undefined;
  let actionError: unknown = null;
  try {
    result = await opts.action();
  } catch (err) {
    actionError = err;
  } finally {
    opts.page.off("framenavigated", onFrameNavigated);
  }

  await assertObservedInteractionNavigations(
    {
      ...opts,
      observed: {
        mainFrameNavigated:
          navigatedDuringAction || didCrossDocumentUrlChange(opts.page, opts.previousUrl),
        subframes: subframeNavigationsDuringAction,
      },
    },
    async () => {
      // A delayed policy denial wins over the action error. Successful calls
      // replace the previous page guard; failed actions keep their own observer.
      const observed = await observeDelayedInteractionNavigation(
        opts.page,
        opts.previousUrl,
        !actionError,
      );
      if (observed) {
        try {
          await assertObservedInteractionNavigations({ ...opts, observed });
        } catch (error) {
          throw actionError ? error : toErrorObject(error, "Non-Error rejection");
        }
      }
    },
  );

  if (actionError) {
    throw toErrorObject(actionError, "Non-Error thrown");
  }
  return result as T;
}

export async function awaitActionWithAbort<T>(
  actionPromise: Promise<T>,
  abortPromise?: Promise<never>,
  onActionResolvedAfterAbort?: () => void,
): Promise<T> {
  if (!abortPromise) {
    return await actionPromise;
  }
  try {
    return await Promise.race([actionPromise, abortPromise]);
  } catch (err) {
    // If abort wins the race, the action may reject later; avoid unhandled rejections.
    void actionPromise.then(
      () => onActionResolvedAfterAbort?.(),
      () => {},
    );
    throw err;
  }
}

export async function awaitNavigationGuardedInteraction<T>(
  opts: {
    action: () => Promise<T>;
    cdpUrl: string;
    page: Page;
    targetId?: string;
    assertCurrent?: InteractionTargetOptions["assertCurrent"];
  } & BrowserNavigationPolicyOptions,
  abortPromise?: Promise<never>,
  signal?: AbortSignal,
  onActionResolvedAfterAbort?: () => void,
): Promise<T> {
  type PolicyCheckOutcome = { state: "allowed" } | { state: "failed"; error: unknown };
  const navigationPolicy = interactionNavigationPolicy(opts);
  const hasNavigationPolicy = hasInteractionNavigationPolicy(navigationPolicy);
  let observedPolicyError: unknown;
  const activePolicyChecks = new Set<Promise<PolicyCheckOutcome>>();
  let unsafeSourceQuarantine: Promise<void> | undefined;
  const quarantineUnsafeSource = () =>
    (unsafeSourceQuarantine ??= quarantineBlockedNavigationTarget({
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      targetId: opts.targetId,
    }));
  const guardedAction = withPageNavigationRequestGuard({
    page: opts.page,
    ...navigationPolicy,
    onPolicyCheckStarted: (check) => {
      const tracked = check.then<PolicyCheckOutcome, PolicyCheckOutcome>(
        () => ({ state: "allowed" }),
        (error: unknown) => ({ state: "failed", error }),
      );
      activePolicyChecks.add(tracked);
      void tracked.then((outcome) => {
        // Keep failures until this interaction settles so an abort cannot race
        // between a denied decision and its route-handler continuation.
        if (outcome.state === "allowed") {
          activePolicyChecks.delete(tracked);
        }
      });
    },
    onPolicyDenied: (event) => {
      observedPolicyError = event.error;
      if (event.state === "handled" && !event.sourcePreserved) {
        void quarantineUnsafeSource().catch(() => {});
      }
    },
    action: async (baselineUrl) => {
      let actionSettledAtMs: number | undefined;
      try {
        return await assertInteractionNavigationCompletedSafely({
          ...opts,
          action: async () => {
            try {
              // Preserve native dispatch ordering for callers without an authority check.
              if (opts.assertCurrent) {
                const assertion = assertInteractionCurrent(opts);
                if (assertion) {
                  await assertion;
                }
              }
              throwIfInteractionAborted(signal);
              return await opts.action();
            } finally {
              actionSettledAtMs = Date.now();
            }
          },
          previousUrl: baselineUrl,
        });
      } finally {
        if (hasNavigationPolicy && actionSettledAtMs !== undefined) {
          // The canonical post-check can settle on the first safe navigation.
          // Keep request interception for the full grace after the raw action.
          const elapsedMs = Math.max(0, Date.now() - actionSettledAtMs);
          const remainingMs = Math.max(0, BROWSER_ACTION_NAVIGATION_GRACE_MS - elapsedMs);
          if (remainingMs > 0) {
            await sleepWithAbort(remainingMs);
          }
          // The canonical observer can settle on an earlier safe navigation.
          // Recheck the final committed URL before releasing request routing.
          await assertPageNavigationCompletedSafely({
            cdpUrl: opts.cdpUrl,
            page: opts.page,
            response: null,
            ...navigationPolicy,
            targetId: opts.targetId,
          });
        }
      }
    },
  }).catch(async (err: unknown) => {
    if (
      isPolicyDenyNavigationError(err) &&
      !wasBrowserNavigationSourcePreservedAfterPolicyDenial(err)
    ) {
      await quarantineUnsafeSource();
    }
    throw err;
  });
  try {
    return await awaitActionWithAbort(guardedAction, abortPromise, onActionResolvedAfterAbort);
  } catch (err) {
    if (observedPolicyError === undefined && activePolicyChecks.size > 0) {
      const outcomes = await Promise.all(activePolicyChecks);
      observedPolicyError = outcomes.find(
        (outcome): outcome is Extract<PolicyCheckOutcome, { state: "failed" }> =>
          outcome.state === "failed" && isPolicyDenyNavigationError(outcome.error),
      )?.error;
    }
    if (observedPolicyError !== undefined) {
      // Once policy denial is observed, keep the route and source-state owner
      // alive until the raw action settles; otherwise an aborted caller could
      // select a page before a later preservation failure is quarantined.
      await guardedAction;
      throw toErrorObject(observedPolicyError, "Non-Error thrown");
    }
    throw err;
  }
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
  const { promise: abortPromise, reject } = createDeferred<never>();
  const abortListener = () => {
    onAbort?.(signal.reason);
    reject(toErrorObject(signal.reason ?? new Error("aborted"), "Non-Error rejection"));
  };
  if (signal.aborted) {
    abortListener();
  } else {
    signal.addEventListener("abort", abortListener, { once: true });
  }
  // Avoid unhandled rejections on early returns.
  void abortPromise.catch(() => {});
  return {
    abortPromise,
    cleanup: () => signal.removeEventListener("abort", abortListener),
  };
}
