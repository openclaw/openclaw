import type { Server } from "node:http";
import type { ChromeMcpPageProbe } from "./chrome-mcp-contracts.js";
import type { RunningChrome } from "./chrome.js";
import type {
  BrowserOpenResult,
  BrowserTab,
  BrowserTransport,
  ProfileStatus as BrowserClientProfileStatus,
} from "./client.types.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";
import type { ExtensionRelayResource } from "./extension-relay/relay-access.js";

export type { BrowserTab };

export type BrowserTabTargetOptions = BrowserOperationOptions & {
  /** Resolve only the raw target-id namespace for an id already selected internally. */
  exactTargetId?: true;
  /** Revalidate the owner after target preparation, before a new native effect. */
  assertCurrent?: () => void | Promise<void>;
};

export type ProfileRuntimeState = {
  profile: ResolvedBrowserProfile;
  running: RunningChrome | null;
  /** Process-memory observation bound to one externally owned browser instance. */
  externalBrowserMode?: {
    browserWebSocketUrl: string;
    headless: Promise<boolean | undefined>;
  };
  managedLaunchFailure?: {
    consecutiveFailures: number;
    cooldownUntil?: number;
    lastError: string;
  };
  /** Sticky tab selection when callers omit targetId (keeps snapshot+act consistent). */
  lastTargetId?: string | null;
  /** Stable, user-facing tab aliases scoped to this profile runtime. */
  tabAliases?: {
    nextTabNumber: number;
    byTargetId: Record<string, { tabId: string; label?: string; url?: string }>;
  };
};

export type BrowserServerState = {
  server?: Server | null;
  port: number;
  resolved: ResolvedBrowserConfig;
  profiles: Map<string, ProfileRuntimeState>;
  /** Running extension relay servers keyed by profile name (extension driver). */
  extensionRelays?: Map<string, ExtensionRelayResource>;
  stopUnhandledRejectionHandler?: () => void;
};

export type BrowserOperationOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type EnsureTabAvailableOptions = BrowserOperationOptions & {
  /** Allow a target-id-only tab when the caller can continue through Playwright. */
  allowPlaywrightFallback?: boolean;
};

export type ProfileContext = {
  profile: ResolvedBrowserProfile;
  ensureBrowserAvailable: (opts?: { headless?: boolean; signal?: AbortSignal }) => Promise<void>;
  ensureTabAvailable: (
    targetId?: string,
    options?: EnsureTabAvailableOptions,
  ) => Promise<BrowserTab>;
  isHttpReachable: (timeoutMs?: number, signal?: AbortSignal) => Promise<boolean>;
  isTransportAvailable: (
    timeoutMs?: number,
    signal?: AbortSignal,
    pageProbe?: ChromeMcpPageProbe,
  ) => Promise<boolean>;
  isReachable: (timeoutMs?: number, options?: { signal?: AbortSignal }) => Promise<boolean>;
  listTabs: (options?: BrowserOperationOptions) => Promise<BrowserTab[]>;
  openTab: (
    url: string,
    opts?: {
      label?: string;
      signal?: AbortSignal;
      timeoutMs?: number;
      requireDurableOwnership?: boolean;
    },
  ) => Promise<BrowserOpenResult>;
  labelTab: (targetId: string, label: string) => Promise<BrowserTab>;
  focusTab: (targetId: string, options?: BrowserTabTargetOptions) => Promise<void>;
  closeTab: (targetId: string, options?: BrowserTabTargetOptions) => Promise<string>;
  stopRunningBrowser: () => Promise<{ stopped: boolean }>;
  resetProfile: () => Promise<{ moved: boolean; from: string; to?: string }>;
};

export type BrowserRouteContext = {
  state: () => BrowserServerState;
  forProfile: (profileName?: string) => ProfileContext;
  listProfiles: () => Promise<ProfileStatus[]>;
};

export type ProfileStatus = BrowserClientProfileStatus & {
  transport: BrowserTransport;
};

export type ContextOptions = {
  getState: () => BrowserServerState | null;
  onEnsureAttachTarget?: (profile: ResolvedBrowserProfile) => Promise<void>;
  refreshConfigFromDisk?: boolean;
};
