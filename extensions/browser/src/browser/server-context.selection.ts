import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage, type SsrFPolicy } from "openclaw/plugin-sdk/security-runtime";
import { assertChromeMcpCdpTransportAllowed } from "./cdp-reachability-policy.js";
import { fetchOk, normalizeCdpHttpBaseForJsonEndpoints } from "./cdp.helpers.js";
import { appendCdpPath } from "./cdp.js";
import { getChromeMcpModule } from "./chrome-mcp.runtime.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { BrowserError, BrowserTabNotFoundError } from "./errors.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import { getPwAiModule } from "./pw-ai-module.js";
import {
  CLOSE_TAB_VERIFY_POLL_MS,
  CLOSE_TAB_VERIFY_WINDOW_MS,
  OPEN_TAB_DISCOVERY_POLL_MS,
  OPEN_TAB_DISCOVERY_WINDOW_MS,
} from "./server-context.constants.js";
import type {
  BrowserTab,
  BrowserOperationOptions,
  BrowserTabTargetOptions,
  EnsureTabAvailableOptions,
  ProfileContext,
  ProfileRuntimeState,
} from "./server-context.types.js";
import { dispatchBrowserTabClose } from "./session-tab-store.js";
import { resolveBrowserTabOrThrow, resolveTargetIdFromTabs } from "./target-id.js";

type SelectionDeps = {
  profile: ResolvedBrowserProfile;
  runtime: ProfileRuntimeState;
  getCdpControlPolicy: () => SsrFPolicy | undefined;
  listTabs: (options?: BrowserOperationOptions) => Promise<BrowserTab[]>;
  openTab: (url: string, options?: BrowserOperationOptions) => Promise<BrowserTab>;
};

type SelectionOps = Pick<ProfileContext, "ensureTabAvailable" | "focusTab" | "closeTab">;

function mergeOpenedTabSnapshot(
  tabs: BrowserTab[],
  openedTab: BrowserTab | undefined,
): BrowserTab[] {
  if (!openedTab) {
    return tabs;
  }
  const index = tabs.findIndex((tab) => tab.targetId === openedTab.targetId);
  if (index < 0) {
    return [...tabs, openedTab];
  }
  const listedTab = tabs[index];
  if (!listedTab || listedTab.wsUrl || !openedTab.wsUrl) {
    return tabs;
  }
  const merged = tabs.slice();
  merged[index] = {
    ...listedTab,
    wsUrl: openedTab.wsUrl,
    ...(openedTab.wsLookup ? { wsLookup: openedTab.wsLookup } : {}),
  };
  return merged;
}

export function createProfileSelectionOps({
  profile,
  runtime,
  getCdpControlPolicy,
  listTabs,
  openTab,
}: SelectionDeps): SelectionOps {
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(profile.cdpUrl);
  const capabilities = getBrowserProfileCapabilities(profile);

  const ensureTabAvailable = async (
    targetId?: string,
    options?: EnsureTabAvailableOptions,
  ): Promise<BrowserTab> => {
    options?.signal?.throwIfAborted();
    let lastNonEmptyTabs: BrowserTab[] = [];
    let lastListError: unknown;
    let sawSuccessfulList = false;
    let openedTab: BrowserTab | undefined;

    const readTabs = async (): Promise<BrowserTab[]> => {
      try {
        const tabs = await listTabs(options);
        options?.signal?.throwIfAborted();
        sawSuccessfulList = true;
        if (tabs.length > 0) {
          lastNonEmptyTabs = tabs;
        }
        return tabs;
      } catch (err) {
        options?.signal?.throwIfAborted();
        lastListError = err;
        return [];
      }
    };

    const openWhenConfirmedEmpty = async (tabs: BrowserTab[]): Promise<void> => {
      if (targetId !== undefined) {
        return;
      }
      if (!openedTab && sawSuccessfulList && lastNonEmptyTabs.length === 0 && tabs.length === 0) {
        openedTab = await openTab("about:blank", options);
      }
    };

    const candidateTabs = (tabs: BrowserTab[]) =>
      capabilities.supportsPerTabWs ? tabs.filter((tab) => Boolean(tab.wsUrl)) : tabs;
    const canResolveSelection = (tabs: BrowserTab[]) => {
      const desiredTargetId = targetId ?? openedTab?.targetId ?? runtime.lastTargetId ?? undefined;
      if (!desiredTargetId) {
        return tabs.length > 0;
      }
      if (targetId === undefined) {
        return tabs.some((tab) => tab.targetId === desiredTargetId);
      }
      const resolved = resolveTargetIdFromTabs(desiredTargetId, tabs);
      return resolved.ok || resolved.reason === "ambiguous";
    };

    const tabs1 = await readTabs();
    await openWhenConfirmedEmpty(tabs1);

    let listedTabs = await readTabs();
    await openWhenConfirmedEmpty(listedTabs);
    let unfilteredTabs = mergeOpenedTabSnapshot(listedTabs, openedTab);
    let candidates = candidateTabs(unfilteredTabs);
    const preservedCanResolveSelection = () =>
      canResolveSelection(mergeOpenedTabSnapshot(lastNonEmptyTabs, openedTab));

    if (
      capabilities.supportsPerTabWs &&
      !canResolveSelection(candidates) &&
      (candidates.length === 0 ||
        canResolveSelection(unfilteredTabs) ||
        preservedCanResolveSelection())
    ) {
      const deadline = performance.now() + OPEN_TAB_DISCOVERY_WINDOW_MS;
      while (performance.now() < deadline) {
        await sleepWithAbort(OPEN_TAB_DISCOVERY_POLL_MS, options?.signal);
        listedTabs = await readTabs();
        await openWhenConfirmedEmpty(listedTabs);
        unfilteredTabs = mergeOpenedTabSnapshot(listedTabs, openedTab);
        candidates = candidateTabs(unfilteredTabs);
        if (canResolveSelection(candidates)) {
          break;
        }
      }
    }

    if (!canResolveSelection(candidates)) {
      // Keep the last useful discovery snapshot across empty or failed relists.
      // Target-id-only fallback is opt-in because only Playwright-backed callers can use it safely.
      const preservedTabs = mergeOpenedTabSnapshot(lastNonEmptyTabs, openedTab);
      const preservedCandidates = candidateTabs(preservedTabs);
      if (canResolveSelection(preservedCandidates)) {
        candidates = preservedCandidates;
      } else if (options?.allowPlaywrightFallback && canResolveSelection(preservedTabs)) {
        candidates = preservedTabs;
      }
    }

    if (candidates.length === 0 && !sawSuccessfulList && lastListError) {
      throw lastListError instanceof Error
        ? lastListError
        : new Error(formatErrorMessage(lastListError));
    }

    const stickyTargetId = runtime.lastTargetId ?? undefined;
    // Sticky selection is an identity promise: a missing target requires a fresh
    // explicit choice. Without one, prefer page tabs over background targets.
    const chosen = targetId
      ? resolveBrowserTabOrThrow(targetId, candidates)
      : stickyTargetId
        ? candidates.find((tab) => tab.targetId === stickyTargetId)
        : (candidates.find((tab) => (tab.type ?? "page") === "page") ?? candidates.at(0));

    if (!chosen) {
      throw new BrowserTabNotFoundError({ input: targetId ?? stickyTargetId });
    }
    runtime.lastTargetId = chosen.targetId;
    return chosen;
  };

  const resolveTargetIdOrThrow = async (
    targetId: string,
    options?: BrowserTabTargetOptions,
  ): Promise<string> => {
    const tabs = await listTabs(options);
    return resolveBrowserTabOrThrow(targetId, tabs, options?.exactTargetId).targetId;
  };

  // /json/close answers 200 "Target is closing" once Chrome has requested the close,
  // not once the page is gone, so confirm the target left the list before reporting success.
  const assertTabClosed = async (
    targetId: string,
    options?: BrowserTabTargetOptions,
  ): Promise<void> => {
    const deadline = performance.now() + CLOSE_TAB_VERIFY_WINDOW_MS;
    for (;;) {
      let stillOpen: boolean;
      try {
        stillOpen = (await listTabs(options)).some((tab) => tab.targetId === targetId);
      } catch (error) {
        options?.signal?.throwIfAborted();
        // A failed listing (timeout, 429, policy) proves nothing about the tab. Accepted edge:
        // a browser that exited with its last tab also lands here and reports this error.
        throw new BrowserError(
          `Close was requested but tab ${targetId} may still be open: ` +
            `the tab list could not be read (${formatErrorMessage(error)}). ` +
            "Confirm the tab's state in the browser, or ask the user to, before closing again.",
          500,
          { cause: error },
        );
      }
      if (!stillOpen) {
        return;
      }
      if (performance.now() >= deadline) {
        throw new BrowserError(
          `Browser did not close tab ${targetId}: it is still open after the close request. ` +
            "A page prompt such as a beforeunload dialog may be blocking it; resolve the prompt " +
            "in the browser (or ask the user to), then retry close.",
        );
      }
      await sleepWithAbort(CLOSE_TAB_VERIFY_POLL_MS, options?.signal);
    }
  };

  const prepareTabOperation = async (
    action: "focus" | "close",
    resolvedTargetId: string,
    options?: BrowserTabTargetOptions,
  ): Promise<() => Promise<void>> => {
    if (capabilities.usesChromeMcp) {
      assertChromeMcpCdpTransportAllowed(profile, getCdpControlPolicy());
      const mod = await getChromeMcpModule();
      const run = action === "focus" ? mod.focusChromeMcpTab : mod.closeChromeMcpTab;
      return () => run(profile.name, resolvedTargetId, profile, options);
    }

    const assertCurrent = action === "focus" ? options?.assertCurrent : undefined;
    if (capabilities.usesPersistentPlaywright || assertCurrent) {
      const mod = await getPwAiModule({ mode: "strict" });
      if (mod) {
        const run =
          action === "focus"
            ? mod.focusPageByTargetIdViaPlaywright
            : mod.closePageByTargetIdViaPlaywright;
        return () =>
          run({
            cdpUrl: profile.cdpUrl,
            targetId: resolvedTargetId,
            ssrfPolicy: getCdpControlPolicy(),
            ...(options?.signal ? { signal: options.signal } : {}),
            ...(assertCurrent ? { assertCurrent } : {}),
          });
      }
      if (assertCurrent) {
        throw new Error("Playwright focus is unavailable for this dashboard tab");
      }
    }

    return async () => {
      await fetchOk(
        appendCdpPath(
          cdpHttpBase,
          `/json/${action === "focus" ? "activate" : "close"}/${resolvedTargetId}`,
        ),
        undefined,
        options?.signal ? { signal: options.signal } : undefined,
        getCdpControlPolicy(),
      );
      if (action === "close") {
        await assertTabClosed(resolvedTargetId, options);
      }
    };
  };

  const focusTab = async (targetId: string, options?: BrowserTabTargetOptions): Promise<void> => {
    const resolvedTargetId = await resolveTargetIdOrThrow(targetId, options);
    const focus = await prepareTabOperation("focus", resolvedTargetId, options);
    options?.signal?.throwIfAborted();
    await focus();
    runtime.lastTargetId = resolvedTargetId;
  };

  const closeTab = async (targetId: string, options?: BrowserTabTargetOptions): Promise<string> => {
    const resolvedTargetId = await resolveTargetIdOrThrow(targetId, options);
    const close = await prepareTabOperation("close", resolvedTargetId, options);
    options?.signal?.throwIfAborted();
    await dispatchBrowserTabClose(resolvedTargetId, profile.name, () => {
      options?.signal?.throwIfAborted();
      return close();
    });

    if (runtime.lastTargetId === resolvedTargetId) {
      // Retire only the closed sticky identity; otherwise an unprovable session
      // handle can block every later targetless action.
      runtime.lastTargetId = null;
    }
    return resolvedTargetId;
  };

  return {
    ensureTabAvailable,
    focusTab,
    closeTab,
  };
}
