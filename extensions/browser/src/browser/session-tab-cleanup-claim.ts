/**
 * Durable tab cleanup owns claims, fingerprint verification, close, and retirement.
 * A concurrent touch or competing sweep cannot delete another generation's row.
 */
import { randomUUID } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CloseTrackedCdpTargetResult } from "./cdp.helpers.js";
import type { ResolvedBrowserConfig } from "./config.js";
import { BROWSER_TAB_UNREACHABLE_RETIRE_MS } from "./constants.js";
import { clearDurableTabAliases } from "./session-tab-ephemeral-aliases.js";
import { activeDurableStorageKeys } from "./session-tab-process-state.js";
import type { BrowserSessionTabRoute } from "./session-tab-route.js";
import {
  type BrowserSessionTabRecord,
  deleteBrowserSessionTabIf,
  getBrowserSessionTabStore,
  parseBrowserSessionTabRecord,
  sameBrowserSessionTabRecord,
  updateBrowserSessionTab,
} from "./session-tab-store.js";

type DurableTab = BrowserSessionTabRecord & {
  kind: "durable";
  storageKey: string;
};

export type CleanupKind = "lifecycle" | "sweep";

type DurableCleanupResult =
  | CloseTrackedCdpTargetResult
  | { status: "unavailable"; reason: "extension-relay-unavailable" };
type CloseTab = (tab: {
  targetId: string;
  nativeTargetId?: string;
  baseUrl?: string;
  route?: BrowserSessionTabRoute;
  profile?: string;
}) => Promise<void>;
export type CloseParams = {
  closeTab?: CloseTab;
  closeDurableTab?: (
    tab: DurableTab,
    options: { shouldClose: () => boolean },
  ) => Promise<CloseTrackedCdpTargetResult>;
  getResolvedBrowserConfig?: () =>
    | ResolvedBrowserConfig
    | null
    | Promise<ResolvedBrowserConfig | null>;
  onWarn?: (message: string) => void;
};

export function isIgnorableTabCloseError(error: unknown): boolean {
  const message = normalizeLowercaseStringOrEmpty(String(error));
  return (
    message.includes("tab not found") ||
    message.includes("target closed") ||
    message.includes("target not found") ||
    message.includes("no such target") ||
    message.includes("no target with given id found")
  );
}

function claimCleanup(tab: DurableTab, now: number, kind: CleanupKind): DurableTab | undefined {
  const cleanupAttemptToken = randomUUID();
  // Lifecycle intent survives periodic retries; a touch may revoke only an
  // idle/cap sweep claim, never cleanup for a session that already ended.
  const cleanupKind = kind === "lifecycle" ? "lifecycle" : (tab.cleanupKind ?? kind);
  const claimed = updateBrowserSessionTab(tab.storageKey, (current) => {
    const record = parseBrowserSessionTabRecord(current);
    if (!record || !sameBrowserSessionTabRecord(record, tab)) {
      return undefined;
    }
    return {
      ...record,
      cleanupRequestedAt: now,
      cleanupAttemptToken,
      cleanupKind,
    };
  });
  return claimed
    ? { ...tab, cleanupRequestedAt: now, cleanupAttemptToken, cleanupKind }
    : undefined;
}

function matchesCleanupAttempt(
  current: BrowserSessionTabRecord | undefined,
  tab: DurableTab,
): current is BrowserSessionTabRecord {
  return Boolean(
    current &&
    current.cleanupAttemptToken === tab.cleanupAttemptToken &&
    current.cleanupRequestedAt === tab.cleanupRequestedAt &&
    current.cleanupKind === tab.cleanupKind &&
    // Lifecycle activity may advance lastUsedAt without revoking mandatory
    // cleanup. Every other field, especially the generation, must still match.
    sameBrowserSessionTabRecord({ ...current, lastUsedAt: tab.lastUsedAt }, tab),
  );
}

function ownsCleanupAttempt(tab: DurableTab): boolean {
  const current = parseBrowserSessionTabRecord(getBrowserSessionTabStore().lookup(tab.storageKey));
  return matchesCleanupAttempt(current, tab);
}

function deleteClaimedTab(tab: DurableTab, onWarn?: (message: string) => void): void {
  try {
    if (tab.dashboard?.state === "stopping") {
      updateBrowserSessionTab(tab.storageKey, (current) => {
        const record = parseBrowserSessionTabRecord(current);
        if (!matchesCleanupAttempt(record, tab) || !record.dashboard) {
          return undefined;
        }
        const {
          cleanupRequestedAt: _requested,
          cleanupAttemptToken: _token,
          cleanupKind: _kind,
          ...settled
        } = record;
        return { ...settled, dashboard: { ...record.dashboard, state: "stopped" } };
      });
      return;
    }
    const deleted = deleteBrowserSessionTabIf(tab.storageKey, (current) => {
      const record = parseBrowserSessionTabRecord(current);
      return matchesCleanupAttempt(record, tab);
    });
    if (deleted) {
      clearDurableTabAliases(tab.storageKey);
      activeDurableStorageKeys().delete(tab.storageKey);
    }
  } catch (error) {
    onWarn?.(`failed to delete tracked browser tab ${tab.nativeTargetId}: ${String(error)}`);
  }
}

async function closeCurrentDurableTab(
  tab: DurableTab,
  shouldClose: () => boolean,
  getResolvedBrowserConfig?: CloseParams["getResolvedBrowserConfig"],
): Promise<DurableCleanupResult> {
  // Empty session cleanup must not initialize Browser control or its CDP graph.
  const [{ getRuntimeConfig }, { resolveCdpControlPolicy }, { closeTrackedCdpTarget }, config] =
    await Promise.all([
      import("../config/config.js"),
      import("./cdp-reachability-policy.js"),
      import("./cdp.helpers.js"),
      import("./config.js"),
    ]);
  let resolved = await getResolvedBrowserConfig?.();
  if (!shouldClose()) {
    return { status: "cancelled" };
  }
  if (!resolved) {
    const cfg = getRuntimeConfig();
    resolved = config.resolveBrowserConfig(cfg.browser, cfg);
  }
  const profile = config.resolveProfile(resolved, tab.profile);
  if (!profile?.cdpUrl) {
    return { status: "ownership-mismatch" };
  }
  if (tab.dashboard && !config.isLocalManagedProfile(profile)) {
    return { status: "ownership-mismatch" };
  }
  if (profile.driver === "extension" && !resolved.extensionRelayInternalTokens[profile.name]) {
    return { status: "unavailable", reason: "extension-relay-unavailable" };
  }
  const cdpControlPolicy = resolveCdpControlPolicy(profile, resolved.ssrfPolicy);
  return await closeTrackedCdpTarget({
    profileName: profile.name,
    cdpUrl: profile.cdpUrl,
    nativeTargetId: tab.nativeTargetId,
    timeoutMs: resolved.remoteCdpTimeoutMs,
    ssrfPolicy: cdpControlPolicy,
    expectedProfileFingerprint: tab.profileFingerprint,
    expectedBrowserInstanceFingerprint: tab.browserInstanceFingerprint,
    shouldClose,
  });
}

export async function closeDurableTab(
  candidate: DurableTab,
  params: CloseParams,
  now: number,
  cleanupKind: CleanupKind,
): Promise<number> {
  if (candidate.dashboard?.state === "active" || candidate.dashboard?.state === "stopped") {
    return 0;
  }
  const tab = claimCleanup(candidate, now, cleanupKind);
  if (!tab) {
    return 0;
  }
  const shouldClose = () => ownsCleanupAttempt(tab);
  let outcome: DurableCleanupResult;
  try {
    if (params.closeDurableTab) {
      outcome = await params.closeDurableTab(tab, { shouldClose });
    } else if (params.closeTab) {
      if (!shouldClose()) {
        return 0;
      }
      await params.closeTab({
        targetId: tab.nativeTargetId,
        nativeTargetId: tab.nativeTargetId,
        profile: tab.profile,
      });
      outcome = { status: "closed" };
    } else {
      outcome = await closeCurrentDurableTab(tab, shouldClose, params.getResolvedBrowserConfig);
    }
  } catch (error) {
    if (isIgnorableTabCloseError(error)) {
      deleteClaimedTab(tab, params.onWarn);
      return 0;
    }
    params.onWarn?.(`failed to close tracked browser tab ${tab.nativeTargetId}: ${String(error)}`);
    return 0;
  }
  if (outcome.status === "cancelled") {
    return 0;
  }
  if (outcome.status === "unavailable") {
    if (outcome.reason === "extension-relay-unavailable") {
      params.onWarn?.(
        `deferred tracked browser tab ${tab.nativeTargetId}: extension relay runtime unavailable`,
      );
      return 0;
    }
    // Expire unreachable ordinary tabs before they fill the bounded tracking store.
    // Retained dashboards require proof of release, regardless of their idle age.
    if (!tab.dashboard && now - tab.lastUsedAt >= BROWSER_TAB_UNREACHABLE_RETIRE_MS) {
      params.onWarn?.(
        `retired unreachable tracked browser tab ${tab.nativeTargetId}: ${outcome.reason}`,
      );
      deleteClaimedTab(tab, params.onWarn);
      return 0;
    }
    params.onWarn?.(`deferred tracked browser tab ${tab.nativeTargetId}: ${outcome.reason}`);
    return 0;
  }
  if (outcome.status === "ownership-mismatch") {
    params.onWarn?.(`retired tracked browser tab ${tab.nativeTargetId}: ownership mismatch`);
    deleteClaimedTab(tab, params.onWarn);
    return 0;
  }
  deleteClaimedTab(tab, params.onWarn);
  return outcome.status === "closed" ? 1 : 0;
}
