import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { fetchOk, normalizeCdpHttpBaseForJsonEndpoints } from "./cdp.helpers.js";
import { appendCdpPath } from "./cdp.js";
import { closeChromeMcpTab, focusChromeMcpTab } from "./chrome-mcp.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { BrowserTabNotFoundError, BrowserTargetAmbiguousError } from "./errors.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import type { PwAiModule } from "./pw-ai-module.js";
import { getPwAiModule } from "./pw-ai-module.js";
import {
  OPEN_TAB_DISCOVERY_POLL_MS,
  WSURL_DISCOVERY_WINDOW_MS,
} from "./server-context.constants.js";
import type { BrowserTab, ProfileRuntimeState } from "./server-context.types.js";
import { resolveTargetIdFromTabs } from "./target-id.js";

type SelectionDeps = {
  profile: ResolvedBrowserProfile;
  getProfileState: () => ProfileRuntimeState;
  ensureBrowserAvailable: () => Promise<void>;
  listTabs: () => Promise<BrowserTab[]>;
  openTab: (url: string) => Promise<BrowserTab>;
};

type SelectionOps = {
  ensureTabAvailable: (targetId?: string) => Promise<BrowserTab>;
  focusTab: (targetId: string) => Promise<void>;
  closeTab: (targetId: string) => Promise<void>;
};

export function createProfileSelectionOps({
  profile,
  getProfileState,
  ensureBrowserAvailable,
  listTabs,
  openTab,
}: SelectionDeps): SelectionOps {
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(profile.cdpUrl);
  const capabilities = getBrowserProfileCapabilities(profile);

  const ensureTabAvailable = async (targetId?: string): Promise<BrowserTab> => {
    await ensureBrowserAvailable();
    const profileState = getProfileState();
    const tabs1 = await listTabs();
    let newlyOpened: BrowserTab | null = null;
    if (tabs1.length === 0) {
      newlyOpened = await openTab("about:blank");
    }

    const tabs = newlyOpened ? await listTabs() : tabs1;
    let candidates = capabilities.supportsPerTabWs ? tabs.filter((t) => Boolean(t.wsUrl)) : tabs;

    // When wsUrl-filtering leaves candidates empty but tabs do exist (e.g. newly
    // opened tab whose CDP wsUrl hasn't populated yet, or post-Playwright-error
    // state), poll briefly then fall back to unfiltered tabs so we don't throw
    // "tab not found" for reachable targets.
    if (candidates.length === 0 && tabs.length > 0 && capabilities.supportsPerTabWs) {
      const deadline = Date.now() + WSURL_DISCOVERY_WINDOW_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, OPEN_TAB_DISCOVERY_POLL_MS));
        const refreshed = await listTabs();
        const withWs = refreshed.filter((t) => Boolean(t.wsUrl));
        if (withWs.length > 0) {
          candidates = withWs;
          break;
        }
      }
      // Still empty after polling — use tabs without wsUrl rather than throwing.
      // The persistent Playwright connection can still reach them by targetId.
      if (candidates.length === 0) {
        candidates = tabs;
      }
    }

    // If listTabs() returned empty even after openTab, use the opened tab directly.
    if (candidates.length === 0 && newlyOpened) {
      candidates = [newlyOpened];
    }

    const resolveById = (raw: string) => {
      const resolved = resolveTargetIdFromTabs(raw, candidates);
      if (!resolved.ok) {
        if (resolved.reason === "ambiguous") {
          return "AMBIGUOUS" as const;
        }
        return null;
      }
      return candidates.find((t) => t.targetId === resolved.targetId) ?? null;
    };

    const pickDefault = () => {
      const last = normalizeOptionalString(profileState.lastTargetId) ?? "";
      const lastResolved = last ? resolveById(last) : null;
      if (lastResolved && lastResolved !== "AMBIGUOUS") {
        return lastResolved;
      }
      // Prefer a real page tab first (avoid service workers/background targets).
      const page = candidates.find((t) => (t.type ?? "page") === "page");
      return page ?? candidates.at(0) ?? null;
    };

    const chosen = targetId ? resolveById(targetId) : pickDefault();

    if (chosen === "AMBIGUOUS") {
      throw new BrowserTargetAmbiguousError();
    }
    if (!chosen) {
      throw new BrowserTabNotFoundError();
    }
    profileState.lastTargetId = chosen.targetId;
    return chosen;
  };

  const resolveTargetIdOrThrow = async (targetId: string): Promise<string> => {
    const tabs = await listTabs();
    const resolved = resolveTargetIdFromTabs(targetId, tabs);
    if (!resolved.ok) {
      if (resolved.reason === "ambiguous") {
        throw new BrowserTargetAmbiguousError();
      }
      throw new BrowserTabNotFoundError();
    }
    return resolved.targetId;
  };

  const focusTab = async (targetId: string): Promise<void> => {
    const resolvedTargetId = await resolveTargetIdOrThrow(targetId);

    if (capabilities.usesChromeMcp) {
      await focusChromeMcpTab(profile.name, resolvedTargetId, profile.userDataDir);
      const profileState = getProfileState();
      profileState.lastTargetId = resolvedTargetId;
      return;
    }

    if (capabilities.usesPersistentPlaywright) {
      const mod = await getPwAiModule({ mode: "strict" });
      const focusPageByTargetIdViaPlaywright = (mod as Partial<PwAiModule> | null)
        ?.focusPageByTargetIdViaPlaywright;
      if (typeof focusPageByTargetIdViaPlaywright === "function") {
        await focusPageByTargetIdViaPlaywright({
          cdpUrl: profile.cdpUrl,
          targetId: resolvedTargetId,
        });
        const profileState = getProfileState();
        profileState.lastTargetId = resolvedTargetId;
        return;
      }
    }

    await fetchOk(appendCdpPath(cdpHttpBase, `/json/activate/${resolvedTargetId}`));
    const profileState = getProfileState();
    profileState.lastTargetId = resolvedTargetId;
  };

  const closeTab = async (targetId: string): Promise<void> => {
    const resolvedTargetId = await resolveTargetIdOrThrow(targetId);

    if (capabilities.usesChromeMcp) {
      await closeChromeMcpTab(profile.name, resolvedTargetId, profile.userDataDir);
      return;
    }

    // For remote profiles, use Playwright's persistent connection to close tabs
    if (capabilities.usesPersistentPlaywright) {
      const mod = await getPwAiModule({ mode: "strict" });
      const closePageByTargetIdViaPlaywright = (mod as Partial<PwAiModule> | null)
        ?.closePageByTargetIdViaPlaywright;
      if (typeof closePageByTargetIdViaPlaywright === "function") {
        await closePageByTargetIdViaPlaywright({
          cdpUrl: profile.cdpUrl,
          targetId: resolvedTargetId,
        });
        return;
      }
    }

    await fetchOk(appendCdpPath(cdpHttpBase, `/json/close/${resolvedTargetId}`));
  };

  return {
    ensureTabAvailable,
    focusTab,
    closeTab,
  };
}
