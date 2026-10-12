// Shared shapes for the durable session tab registry tests. The registry module
// is imported fresh per test, so its types are re-declared here rather than
// exported from production code.
import type { SessionEntryCurrentPreparation } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { BrowserSessionTabAuthority } from "../browser-runtime-state.js";
import type { CloseTrackedCdpTargetResult } from "./cdp.helpers.js";
import type { BrowserTabOwnership } from "./client.types.js";
import type { ResolvedBrowserConfig } from "./config.js";
import type { BrowserSessionTabRoute } from "./session-tab-route.js";

type TabIdentity = {
  sessionKey?: string;
  targetId?: string;
  route?: BrowserSessionTabRoute;
  profile?: string;
  profileAliases?: Array<string | undefined>;
  ownership?: BrowserTabOwnership;
  aliases?: Array<string | undefined>;
};

export type DurableRecord = {
  version: 1;
  sessionKey: string;
  nativeTargetId: string;
  profile: string;
  profileAliases?: string[];
  profileFingerprint: string;
  browserInstanceFingerprint: string;
  interactionTargetKind: "native" | "opaque";
  trackedAt: number;
  lastUsedAt: number;
  cleanupRequestedAt?: number;
  cleanupAttemptToken?: string;
  cleanupKind?: "lifecycle" | "sweep";
};

export type DurableTab = DurableRecord & { kind: "durable"; storageKey: string };

export type CloseTab = (tab: {
  targetId: string;
  nativeTargetId?: string;
  baseUrl?: string;
  profile?: string;
}) => Promise<void>;

type CleanupParams = SessionEntryCurrentPreparation & {
  isCurrent?: () => boolean;
  closeTab?: CloseTab;
  closeDurableTab?: (
    tab: DurableTab,
    options: CloseOptions,
  ) => Promise<CloseTrackedCdpTargetResult>;
  getResolvedBrowserConfig?: () => ResolvedBrowserConfig | null;
  onWarn?: (message: string) => void;
  onDebug?: (message: string) => void;
};

export type CloseOptions = {
  closeIfCurrent: (
    dispatch: () => Promise<CloseTrackedCdpTargetResult>,
  ) => Promise<CloseTrackedCdpTargetResult>;
};

export type RegistryModule = {
  filterTrackedSessionBrowserTabs<T extends { targetId: string; tabId?: string }>(
    params: Pick<TabIdentity, "sessionKey" | "route" | "profile"> & {
      tabs: readonly T[];
      authority?: BrowserSessionTabAuthority;
    },
  ): Promise<T[]>;
  trackSessionBrowserTab(params: TabIdentity & { now?: number }): Promise<DurableTab | undefined>;
  touchSessionBrowserTab(params: TabIdentity & { now?: number }): Promise<void>;
  untrackSessionBrowserTab(params: TabIdentity): Promise<void>;
  closeTrackedBrowserTabsForSessions(
    params: CleanupParams & { sessionKeys: Array<string | undefined>; now?: number },
  ): Promise<number>;
  sweepTrackedBrowserTabs(
    params: CleanupParams & {
      now?: number;
      idleMs?: number;
      maxTabsPerSession?: number;
      ordinaryCleanup?: boolean;
      sessionFilter?: (sessionKey: string) => boolean;
    },
  ): Promise<number>;
};

export const durableOwnership = (
  nativeTargetId: string,
  profileFingerprint = "test-profile-fingerprint",
  browserInstanceFingerprint = "test-browser-instance-fingerprint",
): Extract<BrowserTabOwnership, { status: "durable" }> => ({
  status: "durable",
  nativeTargetId,
  profileFingerprint,
  browserInstanceFingerprint,
});
