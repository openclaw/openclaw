import { setTimeout as sleep } from "node:timers/promises";
import {
  evaluateChromeMcpScript,
  type ChromeMcpOperationOptions,
  type ChromeMcpProfileOptions,
} from "../chrome-mcp.js";
import {
  assertBrowserNavigationResultAllowed,
  type BrowserNavigationPolicyOptions,
  withBrowserNavigationPolicy,
} from "../navigation-guard.js";

const EXISTING_SESSION_INTERACTION_NAVIGATION_RECHECK_DELAYS_MS = [0, 250, 500] as const;
const EXISTING_SESSION_PREFLIGHT_CHANGED_ERROR =
  "Selected browser tab changed during navigation policy preflight; retry the operation.";

export type ExistingSessionOperation = ChromeMcpOperationOptions & {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
};

export type ExistingSessionNavigationGuard = ExistingSessionOperation &
  BrowserNavigationPolicyOptions & {
    /** Resize alone may manage an already-open private tab without reading its contents. */
    allowUnchangedCurrentPageUrlForResize?: boolean;
    listTabs: () => Promise<Array<{ targetId: string; url: string }>>;
    /** Pure reads use one immediate post-check instead of the delayed polling window. */
    skipPostActionNavigationPollingForPureRead?: boolean;
  };

type PreparedExistingSessionNavigationGuard = ExistingSessionNavigationGuard & {
  initialTabUrls: ReadonlyMap<string, string>;
  unchangedSelectedPageUrl?: string;
};

async function assertExistingSessionTabSetAllowed(
  params: PreparedExistingSessionNavigationGuard,
  navigationPolicy: BrowserNavigationPolicyOptions,
): Promise<void> {
  const tabs = await params.listTabs();
  for (const tab of tabs) {
    if (tab.targetId === params.targetId || params.initialTabUrls.get(tab.targetId) === tab.url) {
      continue;
    }
    await assertBrowserNavigationResultAllowed({
      url: tab.url,
      ...navigationPolicy,
    });
  }
}

async function readExistingSessionLocationHref(params: ExistingSessionOperation): Promise<string> {
  const currentUrl = await evaluateChromeMcpScript({
    ...params,
    fn: "() => window.location.href",
  });
  if (typeof currentUrl !== "string") {
    throw new Error("Location probe returned a non-string result");
  }
  const normalizedUrl = currentUrl.trim();
  if (!normalizedUrl) {
    throw new Error("Location probe returned an empty URL");
  }
  return normalizedUrl;
}

async function assertExistingSessionPostInteractionNavigationAllowed(
  params: PreparedExistingSessionNavigationGuard,
): Promise<void> {
  const navigationPolicy = withBrowserNavigationPolicy(params.ssrfPolicy, {
    browserProxyMode: params.browserProxyMode,
  });
  if (
    !navigationPolicy.ssrfPolicy &&
    navigationPolicy.browserProxyMode !== "explicit-browser-proxy"
  ) {
    return;
  }
  let lastObservedUrl: string | undefined;
  let sawStableUrl = false;
  for (const delayMs of EXISTING_SESSION_INTERACTION_NAVIGATION_RECHECK_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs, undefined, { signal: params.signal });
    }
    let currentUrl: string;
    try {
      currentUrl = await readExistingSessionLocationHref(params);
    } catch {
      params.signal?.throwIfAborted();
      sawStableUrl = false;
      lastObservedUrl = undefined;
      continue;
    }
    // Resize may act on an already-open private tab. Exempt only that unchanged
    // selected-page URL; changed destinations and every new tab remain checked.
    if (currentUrl !== params.unchangedSelectedPageUrl) {
      await assertBrowserNavigationResultAllowed({
        url: currentUrl,
        ...navigationPolicy,
      });
    }
    sawStableUrl = currentUrl === lastObservedUrl;
    lastObservedUrl = currentUrl;
  }

  if (sawStableUrl) {
    await assertExistingSessionTabSetAllowed(params, navigationPolicy);
    return;
  }

  // One final probe distinguishes a late stable transition from a page that is
  // still changing after the interaction and therefore cannot be trusted yet.
  if (lastObservedUrl) {
    const lastDelay =
      EXISTING_SESSION_INTERACTION_NAVIGATION_RECHECK_DELAYS_MS[
        EXISTING_SESSION_INTERACTION_NAVIGATION_RECHECK_DELAYS_MS.length - 1
      ];
    await sleep(lastDelay, undefined, { signal: params.signal });
    let followUpUrl: string | undefined;
    try {
      followUpUrl = await readExistingSessionLocationHref(params);
    } catch {
      params.signal?.throwIfAborted();
    }
    if (followUpUrl) {
      if (followUpUrl !== params.unchangedSelectedPageUrl) {
        await assertBrowserNavigationResultAllowed({
          url: followUpUrl,
          ...navigationPolicy,
        });
      }
      if (followUpUrl === lastObservedUrl) {
        await assertExistingSessionTabSetAllowed(params, navigationPolicy);
        return;
      }
    }
  }

  throw new Error("Unable to verify stable post-interaction navigation");
}

export async function runExistingSessionActionWithNavigationGuard<T>(params: {
  execute: () => Promise<T>;
  guard: ExistingSessionNavigationGuard;
}): Promise<T> {
  const navigationPolicy = withBrowserNavigationPolicy(params.guard.ssrfPolicy, {
    browserProxyMode: params.guard.browserProxyMode,
  });
  const shouldCheckNavigation = Boolean(
    navigationPolicy.ssrfPolicy || navigationPolicy.browserProxyMode === "explicit-browser-proxy",
  );
  if (!shouldCheckNavigation) {
    return await params.execute();
  }

  const initialTabUrls = new Map(
    (await params.guard.listTabs()).map((tab) => [tab.targetId, tab.url] as const),
  );
  // The route's ensured tab URL can age while caller setup runs. Probe the exact
  // document immediately before execution and use it as the selected-page baseline.
  const currentPageUrl = await readExistingSessionLocationHref(params.guard);
  initialTabUrls.set(params.guard.targetId, currentPageUrl);
  const unchangedSelectedPageUrl = params.guard.allowUnchangedCurrentPageUrlForResize
    ? currentPageUrl
    : undefined;
  if (!params.guard.allowUnchangedCurrentPageUrlForResize) {
    await assertBrowserNavigationResultAllowed({
      url: currentPageUrl,
      ...navigationPolicy,
    });
  }
  // Policy checks may await DNS while the attached tab keeps navigating. Re-read
  // after that await so the Chrome MCP operation cannot start on a changed URL.
  const preExecutePageUrl = await readExistingSessionLocationHref(params.guard);
  if (preExecutePageUrl !== currentPageUrl) {
    await assertBrowserNavigationResultAllowed({
      url: preExecutePageUrl,
      ...navigationPolicy,
    });
    // Chrome MCP cannot make its URL check and next operation atomic. Refuse a
    // changed document instead of opening another async-check race before dispatch.
    throw new Error(EXISTING_SESSION_PREFLIGHT_CHANGED_ERROR);
  }

  let actionError: unknown;
  let result: T | undefined;
  try {
    result = await params.execute();
  } catch (error) {
    actionError = error;
  }

  const preparedGuard = {
    ...params.guard,
    initialTabUrls,
    unchangedSelectedPageUrl,
  };
  if (params.guard.skipPostActionNavigationPollingForPureRead) {
    await assertBrowserNavigationResultAllowed({
      url: await readExistingSessionLocationHref(params.guard),
      ...navigationPolicy,
    });
    await assertExistingSessionTabSetAllowed(preparedGuard, navigationPolicy);
  } else {
    await assertExistingSessionPostInteractionNavigationAllowed({
      ...preparedGuard,
    });
  }

  if (actionError) {
    throw toLintErrorObject(actionError, "Non-Error thrown");
  }

  return result as T;
}

/**
 * Respond to a modal dialog when in-page location probes are blocked by the
 * dialog itself. The authoritative tab list owns the preflight; once the
 * dialog closes, the normal full selected-page and sibling-tab checks resume.
 */
export async function runExistingSessionDialogResponseWithNavigationGuard(params: {
  execute: () => Promise<boolean>;
  guard: ExistingSessionNavigationGuard;
}): Promise<boolean> {
  const navigationPolicy = withBrowserNavigationPolicy(params.guard.ssrfPolicy, {
    browserProxyMode: params.guard.browserProxyMode,
  });
  const shouldCheckNavigation = Boolean(
    navigationPolicy.ssrfPolicy || navigationPolicy.browserProxyMode === "explicit-browser-proxy",
  );
  if (!shouldCheckNavigation) {
    return await params.execute();
  }

  const initialTabs = await params.guard.listTabs();
  const initialTabUrls = new Map(initialTabs.map((tab) => [tab.targetId, tab.url] as const));
  const selectedUrl = initialTabUrls.get(params.guard.targetId);
  if (!selectedUrl) {
    throw new Error("Selected browser tab disappeared before its dialog could be handled");
  }
  await assertBrowserNavigationResultAllowed({
    url: selectedUrl,
    ...navigationPolicy,
  });
  // A modal prevents the in-page location probe used by ordinary actions, so
  // re-read the authoritative tab list after the asynchronous policy check.
  // This keeps handle_dialog from starting on a target that moved meanwhile.
  const preExecuteTabs = await params.guard.listTabs();
  const preExecuteSelectedUrl = preExecuteTabs.find(
    (tab) => tab.targetId === params.guard.targetId,
  )?.url;
  if (!preExecuteSelectedUrl) {
    throw new Error("Selected browser tab disappeared before its dialog could be handled");
  }
  if (preExecuteSelectedUrl !== selectedUrl) {
    await assertBrowserNavigationResultAllowed({
      url: preExecuteSelectedUrl,
      ...navigationPolicy,
    });
    throw new Error(EXISTING_SESSION_PREFLIGHT_CHANGED_ERROR);
  }

  let actionError: unknown;
  let handled = false;
  try {
    handled = await params.execute();
  } catch (err) {
    actionError = err;
  }

  // A false result is the dependency's exact no-open-dialog outcome and made
  // no page change. Errors are outcome-unknown, so still run the postflight.
  if (handled || actionError) {
    await assertExistingSessionPostInteractionNavigationAllowed({
      ...params.guard,
      initialTabUrls,
    });
  }
  if (actionError) {
    throw toLintErrorObject(actionError, "Non-Error thrown");
  }
  return handled;
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
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
