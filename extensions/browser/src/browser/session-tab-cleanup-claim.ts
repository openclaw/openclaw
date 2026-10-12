/**
 * Durable tab cleanup owns claims, fingerprint verification, close, and retirement.
 * A concurrent touch or competing sweep cannot delete another generation's row.
 */
import { randomUUID } from "node:crypto";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import type { SessionEntryCurrentPreparation } from "openclaw/plugin-sdk/plugin-state-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  getBrowserStateRuntime,
  type BrowserSessionTabAuthority,
} from "../browser-runtime-state.js";
import type { CloseTrackedCdpTargetResult } from "./cdp.helpers.js";
import type { ResolvedBrowserConfig } from "./config.js";
import { BROWSER_TAB_UNREACHABLE_RETIRE_MS } from "./constants.js";
import type { BrowserSessionTabRoute } from "./session-tab-route.js";
import {
  type BrowserSessionTabRecord,
  deleteBrowserSessionTabIf,
  dispatchBrowserSessionTabIfCurrent,
  parseBrowserSessionTabRecord,
  sameBrowserSessionTabRecord,
  updateBrowserSessionTab,
  withoutBrowserSessionTabCleanup,
} from "./session-tab-store.js";
import type { DurableTab } from "./session-tab-tracking.js";

const log = createSubsystemLogger("browser").child("service").child("session-tabs");

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
export type CloseParams = SessionEntryCurrentPreparation & {
  authority?: BrowserSessionTabAuthority;
  /** Gates new cleanup claims, without revoking an already admitted close. */
  isCurrent?: () => boolean;
  closeTab?: CloseTab;
  closeDurableTab?: (
    tab: DurableTab,
    options: { closeIfCurrent: CloseIfCurrent },
  ) => Promise<CloseTrackedCdpTargetResult>;
  getResolvedBrowserConfig?: () =>
    | ResolvedBrowserConfig
    | null
    | Promise<ResolvedBrowserConfig | null>;
  onWarn?: (message: string) => void;
  onDebug?: (message: string) => void;
};

const deferredTabDiagnosticsSymbol = Symbol.for(
  "openclaw.browser.session-tabs.deferred-diagnostics",
);

/** Defensive bound: live deferrals are already forgotten as their rows settle. */
const MAX_DEFERRED_TAB_DIAGNOSTICS = 512;

function deferredTabDiagnostics(): Map<string, string> {
  return resolveGlobalMap(deferredTabDiagnosticsSymbol);
}

/** Records a deferral, returning true when the row has not reported it yet. */
function recordDeferredTabDiagnostic(tab: DurableTab, reason: string): boolean {
  const diagnostics = deferredTabDiagnostics();
  if (diagnostics.get(tab.storageKey) === reason) {
    return false;
  }
  // Re-insert so the least recently reported deferral is evicted first.
  diagnostics.delete(tab.storageKey);
  diagnostics.set(tab.storageKey, reason);
  if (diagnostics.size > MAX_DEFERRED_TAB_DIAGNOSTICS) {
    const oldest = diagnostics.keys().next();
    if (!oldest.done) {
      diagnostics.delete(oldest.value);
    }
  }
  return true;
}

/** Lets a settled row report the next outage instead of staying muted forever. */
function forgetDeferredTabDiagnostic(tab: DurableTab): void {
  const diagnostics = deferredTabDiagnostics();
  diagnostics.delete(tab.storageKey);
}

/** Warn once per deferral; repeated sweeps remain visible at debug level. */
function reportDeferredTab(params: CloseParams, tab: DurableTab, reason: string): void {
  const message = `deferred tracked browser tab ${tab.nativeTargetId}: ${reason}`;
  if (recordDeferredTabDiagnostic(tab, reason)) {
    params.onWarn?.(message);
    return;
  }
  if (params.onDebug) {
    params.onDebug(message);
    return;
  }
  log.debug(message);
}

type CloseIfCurrent = (
  dispatch: () => Promise<CloseTrackedCdpTargetResult>,
) => Promise<CloseTrackedCdpTargetResult>;

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

async function claimCleanup(
  tab: DurableTab,
  now: number,
  kind: CleanupKind,
  authority: BrowserSessionTabAuthority,
): Promise<DurableTab | undefined> {
  const cleanupAttemptToken = randomUUID();
  // Lifecycle intent survives periodic retries; a touch may revoke only an
  // idle/cap sweep claim, never cleanup for a session that already ended.
  const cleanupKind = kind === "lifecycle" ? "lifecycle" : (tab.cleanupKind ?? kind);
  const claimed = await updateBrowserSessionTab(
    tab.storageKey,
    (current) => {
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
    },
    authority,
  );
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
    // Lifecycle activity may advance lastUsedAt without revoking mandatory
    // cleanup. Every other field, especially the generation, must still match.
    sameBrowserSessionTabRecord({ ...current, lastUsedAt: tab.lastUsedAt }, tab),
  );
}

async function deleteClaimedTab(
  tab: DurableTab,
  authority: BrowserSessionTabAuthority,
  onWarn?: (message: string) => void,
): Promise<void> {
  forgetDeferredTabDiagnostic(tab);
  try {
    if (tab.dashboard?.state === "stopping") {
      await updateBrowserSessionTab(
        tab.storageKey,
        (current) => {
          const record = parseBrowserSessionTabRecord(current);
          if (!matchesCleanupAttempt(record, tab) || !record.dashboard) {
            return undefined;
          }
          return {
            ...withoutBrowserSessionTabCleanup(record),
            dashboard: { ...record.dashboard, state: "stopped" },
          };
        },
        authority,
      );
      return;
    }
    await deleteBrowserSessionTabIf(
      tab.storageKey,
      (current) => matchesCleanupAttempt(parseBrowserSessionTabRecord(current), tab),
      authority,
    );
  } catch (error) {
    onWarn?.(`failed to delete tracked browser tab ${tab.nativeTargetId}: ${String(error)}`);
  }
}

async function closeCurrentDurableTab(
  tab: DurableTab,
  closeIfCurrent: CloseIfCurrent,
  getResolvedBrowserConfig?: CloseParams["getResolvedBrowserConfig"],
): Promise<DurableCleanupResult> {
  // Empty session cleanup must not initialize Browser control or its CDP graph.
  const [{ getRuntimeConfig }, { resolveCdpControlPolicy }, { closeTrackedCdpTarget }, config] =
    await Promise.all([
      import("openclaw/plugin-sdk/runtime-config-snapshot"),
      import("./cdp-reachability-policy.js"),
      import("./cdp.helpers.js"),
      import("./config.js"),
    ]);
  let resolved = await getResolvedBrowserConfig?.();
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
    closeIfCurrent,
  });
}

export async function closeDurableTab(
  candidate: DurableTab,
  params: CloseParams,
  now: number,
  cleanupKind: CleanupKind,
): Promise<number> {
  if (params.prepareCurrent && !(await params.prepareCurrent())) {
    return 0;
  }
  if (
    params.isCurrent?.() === false ||
    candidate.dashboard?.state === "active" ||
    candidate.dashboard?.state === "stopped"
  ) {
    return 0;
  }
  const authority = {
    ...params.authority,
    runtime: params.authority?.runtime ?? getBrowserStateRuntime(),
  };
  const tab = await claimCleanup(candidate, now, cleanupKind, {
    ...authority,
    sessionEntryCurrent: params.sessionEntryCurrent,
    assertCurrent: () => {
      authority.assertCurrent?.();
      if (params.isCurrent?.() === false) {
        throw new Error("Browser tab cleanup caller changed");
      }
    },
  });
  if (!tab) {
    return 0;
  }
  const closeIfCurrent: CloseIfCurrent = async (dispatch) =>
    (await dispatchBrowserSessionTabIfCurrent(
      tab.storageKey,
      (current) => matchesCleanupAttempt(parseBrowserSessionTabRecord(current), tab),
      dispatch,
      authority,
    )) ?? { status: "cancelled" };
  let outcome: DurableCleanupResult;
  try {
    if (params.closeDurableTab) {
      outcome = await params.closeDurableTab(tab, { closeIfCurrent });
    } else if (params.closeTab) {
      const closeTab = params.closeTab;
      outcome = await closeIfCurrent(async () => {
        await closeTab({
          targetId: tab.nativeTargetId,
          nativeTargetId: tab.nativeTargetId,
          profile: tab.profile,
        });
        return { status: "closed" };
      });
    } else {
      outcome = await closeCurrentDurableTab(tab, closeIfCurrent, params.getResolvedBrowserConfig);
    }
  } catch (error) {
    if (isIgnorableTabCloseError(error)) {
      await deleteClaimedTab(tab, authority, params.onWarn);
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
      reportDeferredTab(params, tab, "extension relay runtime unavailable");
      return 0;
    }
    // Expire unreachable ordinary tabs before they fill the bounded tracking store.
    // Retained dashboards require proof of release, regardless of their idle age.
    if (!tab.dashboard && now - tab.lastUsedAt >= BROWSER_TAB_UNREACHABLE_RETIRE_MS) {
      params.onWarn?.(
        `retired unreachable tracked browser tab ${tab.nativeTargetId}: ${outcome.reason}`,
      );
      await deleteClaimedTab(tab, authority, params.onWarn);
      return 0;
    }
    reportDeferredTab(params, tab, outcome.reason);
    return 0;
  }
  if (outcome.status === "ownership-mismatch") {
    params.onWarn?.(`retired tracked browser tab ${tab.nativeTargetId}: ownership mismatch`);
  }
  await deleteClaimedTab(tab, authority, params.onWarn);
  return outcome.status === "closed" ? 1 : 0;
}
