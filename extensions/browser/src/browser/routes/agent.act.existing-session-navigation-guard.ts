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

export type ExistingSessionOperation = ChromeMcpOperationOptions & {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
};

export type ExistingSessionNavigationGuard = ExistingSessionOperation &
  BrowserNavigationPolicyOptions & {
    listTabs: () => Promise<Array<{ targetId: string; url: string }>>;
    initialTabTargetIds: ReadonlySet<string>;
  };

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
  params: ExistingSessionNavigationGuard,
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

  const assertNewTabsAllowed = async () => {
    const tabs = await params.listTabs();
    for (const tab of tabs) {
      if (params.initialTabTargetIds.has(tab.targetId)) {
        continue;
      }
      await assertBrowserNavigationResultAllowed({
        url: tab.url,
        ...navigationPolicy,
      });
    }
  };

  let lastObservedUrl: string | undefined;
  let sawStableAllowedUrl = false;
  for (const delayMs of EXISTING_SESSION_INTERACTION_NAVIGATION_RECHECK_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs, undefined, { signal: params.signal });
    }
    let currentUrl: string;
    try {
      currentUrl = await readExistingSessionLocationHref(params);
    } catch {
      params.signal?.throwIfAborted();
      sawStableAllowedUrl = false;
      continue;
    }
    await assertBrowserNavigationResultAllowed({
      url: currentUrl,
      ...navigationPolicy,
    });
    sawStableAllowedUrl = currentUrl === lastObservedUrl;
    lastObservedUrl = currentUrl;
  }

  if (sawStableAllowedUrl) {
    await assertNewTabsAllowed();
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
    try {
      const followUpUrl = await readExistingSessionLocationHref(params);
      await assertBrowserNavigationResultAllowed({
        url: followUpUrl,
        ...navigationPolicy,
      });
      if (followUpUrl === lastObservedUrl) {
        await assertNewTabsAllowed();
        return;
      }
    } catch {
      params.signal?.throwIfAborted();
    }
  }

  throw new Error("Unable to verify stable post-interaction navigation");
}

export async function runExistingSessionActionWithNavigationGuard<T>(params: {
  execute: () => Promise<T>;
  guard?: ExistingSessionNavigationGuard;
}): Promise<T> {
  let actionError: unknown;
  let result: T | undefined;
  try {
    result = await params.execute();
  } catch (error) {
    actionError = error;
  }

  if (params.guard) {
    await assertExistingSessionPostInteractionNavigationAllowed(params.guard);
  }

  if (actionError) {
    throw toLintErrorObject(actionError, "Non-Error thrown");
  }

  return result as T;
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
