import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Page, Response } from "playwright-core";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationRedirectChainAllowed,
  assertBrowserNavigationResultAllowed,
  InvalidBrowserNavigationUrlError,
  type BrowserNavigationPolicyOptions,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import {
  closeConnectionScopedPageBrowser,
  markPageRefBlocked,
  markTargetBlocked,
  pageTargetInfo,
} from "./pw-session-connection.js";
import {
  installNavigationAuthorityFence,
  type NavigationDocumentRoute as Route,
  type NavigationDocumentRequest as Request,
} from "./pw-session-navigation-fence.js";
import { isConnectionScopedPage } from "./pw-session-page-target.js";

/** Return true when an error is a browser navigation policy denial. */
export function isPolicyDenyNavigationError(err: unknown): boolean {
  return err instanceof SsrFBlockedError || err instanceof InvalidBrowserNavigationUrlError;
}

// Mark a page (and its CDP target id when resolvable) as blocked so subsequent
// OpenClaw operations short-circuit instead of re-running the SSRF check on a
// page we have already proven is non-compliant. This is a pure bookkeeping
// step; it does NOT close the tab. Read-only paths can call this safely on a
// user-owned tab without losing the user's content.
export async function quarantineBlockedNavigationTarget(opts: {
  cdpUrl: string;
  page: Page;
  targetId?: string;
}): Promise<void> {
  markPageRefBlocked(opts.cdpUrl, opts.page);
  const resolvedTargetId = (await pageTargetInfo(opts.page).catch(() => null))?.targetId ?? null;
  const fallbackTargetId = normalizeOptionalString(opts.targetId) ?? "";
  const targetIdToBlock = resolvedTargetId || fallbackTargetId;
  if (targetIdToBlock) {
    markTargetBlocked(opts.cdpUrl, targetIdToBlock);
  }
}

// Quarantine and close a tab that OpenClaw itself navigated to a blocked URL.
// Only callers that own the navigation lifecycle (gotoPageWithNavigationGuard
// and the navigate-style entry points that wrap it) may invoke this — closing
// a tab is a destructive action that must not happen on user-owned tabs from
// read-only operations like snapshot/screenshot/interactions.
/** Quarantine and close a tab that OpenClaw navigated to a blocked URL. */
export async function closeBlockedNavigationTarget(opts: {
  cdpUrl: string;
  page: Page;
  targetId?: string;
}): Promise<void> {
  await quarantineBlockedNavigationTarget(opts);
  if (isConnectionScopedPage(opts.page)) {
    const browser = opts.page.context().browser();
    if (browser) {
      await closeConnectionScopedPageBrowser(opts.cdpUrl, browser);
    }
  } else {
    await opts.page.close().catch(() => {});
  }
}

// On policy denial: quarantines and rethrows (never closes).
// Navigate-style callers catch the rethrow and close via closeBlockedNavigationTarget.
/** Validate a completed page navigation and quarantine policy-denied targets. */
export async function assertPageNavigationCompletedSafely(
  opts: {
    cdpUrl: string;
    page: Page;
    response: Response | null;
    targetId?: string;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy, {
    browserProxyMode: opts.browserProxyMode,
    assertNavigationCurrent: opts.assertNavigationCurrent,
  });
  const policySignal = opts.signal ? { signal: opts.signal } : {};
  try {
    await assertBrowserNavigationRedirectChainAllowed({
      request: opts.response?.request(),
      ...navigationPolicy,
      ...policySignal,
    });
    await assertBrowserNavigationResultAllowed({
      url: opts.page.url(),
      ...navigationPolicy,
      ...policySignal,
    });
  } catch (err) {
    if (isPolicyDenyNavigationError(err)) {
      await quarantineBlockedNavigationTarget({
        cdpUrl: opts.cdpUrl,
        page: opts.page,
        targetId: opts.targetId,
      });
    }
    throw err;
  }
}

async function resumeRouteSafely(route: Route, method: "continue" | "fallback"): Promise<void> {
  try {
    await route[method]();
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("Route is already handled"))) {
      throw err;
    }
  }
}

const sourcePreservedPolicyDenials = new WeakSet<object>();

/** Return true when policy denial left the selected page on its source document. */
export function wasBrowserNavigationSourcePreservedAfterPolicyDenial(err: unknown): boolean {
  return typeof err === "object" && err !== null && sourcePreservedPolicyDenials.has(err);
}

/** Run one selected-page action while guarding document requests. */
export async function withPageNavigationRequestGuard<T>(
  opts: {
    action: (baselineUrl: string) => Promise<T>;
    onPolicyCheckStarted?: (check: Promise<void>) => void;
    onPolicyDenied?: (
      event:
        | { state: "detected"; error: unknown }
        | { state: "handled"; error: unknown; sourcePreserved: boolean },
    ) => void;
    page: Page;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<T> {
  const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy, {
    browserProxyMode: opts.browserProxyMode,
    assertNavigationCurrent: opts.assertNavigationCurrent,
  });
  if (
    !navigationPolicy.ssrfPolicy &&
    !navigationPolicy.browserProxyMode &&
    !navigationPolicy.assertNavigationCurrent
  ) {
    return await opts.action(opts.page.url());
  }

  const inFlight = new Set<Promise<void>>();
  let hasGuardError = false;
  let firstGuardError: unknown;
  let deniedDocumentCount = 0;
  let pendingDeniedDocumentCount = 0;
  let unpreservedDocumentCount = 0;
  let policyDeniedDetected = false;
  let lastNotifiedSourcePreserved: boolean | undefined;

  const recordGuardError = (err: unknown) => {
    if (hasGuardError) {
      if (!isPolicyDenyNavigationError(firstGuardError) && isPolicyDenyNavigationError(err)) {
        firstGuardError = err;
      }
      return;
    }
    hasGuardError = true;
    firstGuardError = err;
  };
  const emitPolicyDenied = (
    event:
      | { state: "detected"; error: unknown }
      | { state: "handled"; error: unknown; sourcePreserved: boolean },
  ) => {
    try {
      opts.onPolicyDenied?.(event);
    } catch {
      // Notification only exposes state already owned by this guard.
    }
  };
  const updateSourcePreservation = (notify = true) => {
    if (typeof firstGuardError !== "object" || firstGuardError === null) {
      return;
    }
    let sourcePreserved: boolean | undefined;
    if (unpreservedDocumentCount > 0) {
      sourcePreserved = false;
    } else if (
      isPolicyDenyNavigationError(firstGuardError) &&
      deniedDocumentCount > 0 &&
      pendingDeniedDocumentCount === 0
    ) {
      sourcePreserved = true;
    }
    if (sourcePreserved === undefined) {
      sourcePreservedPolicyDenials.delete(firstGuardError);
      return;
    }
    if (sourcePreserved) {
      sourcePreservedPolicyDenials.add(firstGuardError);
    } else {
      sourcePreservedPolicyDenials.delete(firstGuardError);
    }
    if (notify && policyDeniedDetected && sourcePreserved !== lastNotifiedSourcePreserved) {
      lastNotifiedSourcePreserved = sourcePreserved;
      emitPolicyDenied({ state: "handled", error: firstGuardError, sourcePreserved });
    }
  };
  const notifyPolicyDeniedDetected = () => {
    if (policyDeniedDetected || !isPolicyDenyNavigationError(firstGuardError)) {
      return;
    }
    policyDeniedDetected = true;
    emitPolicyDenied({ state: "detected", error: firstGuardError });
  };
  const stopGuardedRoute = async (
    route: Route,
    preserveDocument: boolean,
    requestError: unknown,
  ) => {
    if (preserveDocument && isPolicyDenyNavigationError(requestError)) {
      deniedDocumentCount += 1;
      pendingDeniedDocumentCount += 1;
      try {
        // CDP cancellation with the operation-owned preservation reason stops
        // the navigation while Chromium keeps the selected source document.
        await route.preserve();
        pendingDeniedDocumentCount -= 1;
        updateSourcePreservation();
        return;
      } catch {
        pendingDeniedDocumentCount -= 1;
        // Abort still stops the document load, but the source may no longer be usable.
      }
    }
    if (preserveDocument) {
      unpreservedDocumentCount += 1;
      updateSourcePreservation();
    }
    await route.abort().catch(() => {});
  };
  const handleRoute = async (route: Route, request: Request) => {
    const preserveDocument = true;
    if (preserveDocument) {
      const policyCheck = assertBrowserNavigationAllowed({
        url: request.url(),
        ...navigationPolicy,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      try {
        opts.onPolicyCheckStarted?.(policyCheck);
      } catch {
        // Observation cannot change the policy decision owned by this guard.
      }
      try {
        await policyCheck;
      } catch (err) {
        recordGuardError(err);
        notifyPolicyDeniedDetected();
        await stopGuardedRoute(route, true, err);
        return;
      }
    }
    try {
      navigationPolicy.assertNavigationCurrent?.();
      await resumeRouteSafely(route, "fallback");
    } catch (err) {
      recordGuardError(err);
      await stopGuardedRoute(route, preserveDocument, err);
    }
  };
  const handler = (route: Route, request: Request) => {
    const operation = handleRoute(route, request).catch(async (err: unknown) => {
      recordGuardError(err);
      await stopGuardedRoute(route, true, err);
    });
    inFlight.add(operation);
    void operation.finally(() => inFlight.delete(operation));
    return operation;
  };

  let removeAuthorityFence: Awaited<ReturnType<typeof installNavigationAuthorityFence>> | undefined;
  let result: T | undefined;
  let actionFailed = false;
  let actionError: unknown;
  try {
    removeAuthorityFence = await installNavigationAuthorityFence(
      opts.page,
      navigationPolicy,
      (error) => {
        recordGuardError(error);
        notifyPolicyDeniedDetected();
        unpreservedDocumentCount += 1;
        updateSourcePreservation();
      },
      handler,
    );
    let baselineUrl = opts.page.url();
    await assertBrowserNavigationResultAllowed({
      url: baselineUrl,
      ...navigationPolicy,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const latestUrl = opts.page.url();
    if (latestUrl !== baselineUrl) {
      // Document interception is already installed, so any later document request remains
      // intercepted. Revalidate the one URL that could commit during preflight.
      await assertBrowserNavigationResultAllowed({
        url: latestUrl,
        ...navigationPolicy,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      baselineUrl = latestUrl;
    }
    navigationPolicy.assertNavigationCurrent?.();
    result = await opts.action(baselineUrl);
  } catch (err) {
    actionFailed = true;
    actionError = err;
    if (isPolicyDenyNavigationError(err)) {
      // Preflight/postflight policy errors describe committed or otherwise
      // unpreserved state. Notify before cleanup can stall on active routes.
      recordGuardError(err);
      notifyPolicyDeniedDetected();
      unpreservedDocumentCount += 1;
      updateSourcePreservation();
    }
  }

  // Drain callbacks before releasing the single document interception owner.
  while (inFlight.size > 0) {
    await Promise.allSettled(inFlight);
  }
  // Successful committed responses may keep loading after ownership retires.
  // Only failed/cancelled actions need page-wide cancellation; uncommitted
  // redirect chains still drain under the fence before successful cleanup.
  const authorityCleanupError = await removeAuthorityFence?.({
    stopLoading: actionFailed || hasGuardError || opts.signal?.aborted,
  });
  const cleanupError = authorityCleanupError;

  // Request-policy denial wins over locator/action/cleanup errors. Only successful
  // preservation cancellations prove every denied document kept its source.
  if (hasGuardError) {
    // Failed fulfillments and action-policy failures already mark the source unpreserved.
    updateSourcePreservation(false);
    throw toErrorObject(firstGuardError, "Non-Error thrown");
  }
  if (actionFailed) {
    throw toErrorObject(actionError, "Non-Error thrown");
  }
  if (cleanupError !== undefined) {
    throw toErrorObject(cleanupError, "Non-Error thrown");
  }
  return result as T;
}

/** Navigate a page while guarding requested URL and redirect chain. */
export async function gotoPageWithNavigationGuard(
  opts: {
    cdpUrl: string;
    page: Page;
    url: string;
    timeoutMs: number;
    targetId?: string;
    signal?: AbortSignal;
    assertPageCurrent?: () => void | Promise<void>;
  } & BrowserNavigationPolicyOptions,
): Promise<Response | null> {
  const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy, {
    browserProxyMode: opts.browserProxyMode,
    assertNavigationCurrent: opts.assertNavigationCurrent,
  });
  let blockedError: unknown = null;

  const handler = async (route: Route, request: Request) => {
    if (blockedError) {
      await route.abort().catch(() => {});
      return;
    }
    const requestKind = request.isTopLevel() ? "top-level" : "subframe";
    try {
      if (requestKind) {
        await assertBrowserNavigationAllowed({
          url: request.url(),
          ...navigationPolicy,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
      }
      navigationPolicy.assertNavigationCurrent?.();
    } catch (err) {
      if (opts.signal?.aborted) {
        await route.abort().catch(() => {});
        return;
      }
      if (isPolicyDenyNavigationError(err) || navigationPolicy.assertNavigationCurrent) {
        if (!isPolicyDenyNavigationError(err) || requestKind === "top-level") {
          blockedError = err;
        }
        await route.abort().catch(() => {});
        return;
      }
      throw err;
    }
    await resumeRouteSafely(route, "continue");
  };

  let removeAuthorityFence: Awaited<ReturnType<typeof installNavigationAuthorityFence>> | undefined;
  let response: Response | null = null;
  let navigationFailed = false;
  let navigationError: unknown;
  try {
    removeAuthorityFence = await installNavigationAuthorityFence(
      opts.page,
      navigationPolicy,
      (error) => {
        blockedError ??= error;
      },
      handler,
    );
    // Synchronous authority must not yield between its final fence and navigation.
    const assertion = opts.assertPageCurrent?.();
    if (assertion) {
      await assertion;
    }
    navigationPolicy.assertNavigationCurrent?.();
    response = await opts.page.goto(opts.url, { timeout: opts.timeoutMs });
  } catch (err) {
    navigationFailed = true;
    navigationError = err;
  }

  const authorityCleanupError = await removeAuthorityFence?.({ stopLoading: navigationFailed });
  const cleanupError = authorityCleanupError;
  if (blockedError) {
    if (isPolicyDenyNavigationError(blockedError)) {
      await closeBlockedNavigationTarget({
        cdpUrl: opts.cdpUrl,
        page: opts.page,
        targetId: opts.targetId,
      });
    }
    throw toErrorObject(blockedError, "Non-Error thrown");
  }
  // A live-page cleanup failure is observable, but the original navigation
  // error owns the result and must not lose its precedence.
  if (navigationFailed) {
    throw navigationError;
  }
  if (cleanupError !== undefined) {
    throw toErrorObject(cleanupError, "Non-Error thrown");
  }
  return response;
}
