import { n as ResolvedBrowserConfig, r as ResolvedBrowserProfile, t as ManagedBrowserHeadlessSource } from "./config-Bwfo-mwZ.js";
import { t as BrowserExecutable } from "./chrome.executables-sU9yfW0S.js";
import { ChildProcess } from "node:child_process";
import { Server } from "node:http";

//#region extensions/browser/src/browser/chrome.d.ts
type RunningChrome = {
  pid: number;
  exe: BrowserExecutable;
  userDataDir: string;
  cdpPort: number;
  startedAt: number;
  proc: ChildProcess;
  headless?: boolean;
  headlessSource?: ManagedBrowserHeadlessSource;
};
//#endregion
//#region extensions/browser/src/browser/client.types.d.ts
type BrowserTransport = "cdp" | "chrome-mcp";
type BrowserHeadlessSource = "request" | "env" | "profile" | "config" | "linux-display-fallback" | "default";
type BrowserStatus = {
  enabled: boolean;
  profile?: string;
  driver?: "openclaw" | "existing-session";
  transport?: BrowserTransport;
  running: boolean;
  cdpReady?: boolean;
  cdpHttp?: boolean;
  /**
   * For Chrome MCP existing-session profiles, true only if a page-level tool
   * round-trip (`list_pages`) completes; for managed CDP profiles, mirrors
   * `cdpReady`. Distinguishes "transport handshake passed" from "page tools
   * are actually usable".
   */
  pageReady?: boolean;
  pid: number | null;
  cdpPort: number | null;
  cdpUrl?: string | null;
  chosenBrowser: string | null;
  detectedBrowser?: string | null;
  detectedExecutablePath?: string | null;
  detectError?: string | null;
  userDataDir: string | null;
  color: string;
  headless: boolean;
  headlessSource?: BrowserHeadlessSource;
  noSandbox?: boolean;
  executablePath?: string | null;
  attachOnly: boolean;
};
type BrowserTab = {
  /** Best handle for agents to pass back as targetId: label, then tabId, then raw targetId. */suggestedTargetId?: string;
  targetId: string; /** Stable, human-friendly tab handle for this profile runtime (for example t1). */
  tabId?: string; /** Optional user-assigned tab label. */
  label?: string;
  title: string;
  url: string;
  wsUrl?: string;
  type?: string;
};
type SnapshotAriaNode = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  description?: string;
  backendDOMNodeId?: number;
  depth: number;
};
//#endregion
//#region extensions/browser/src/browser/server-context.types.d.ts
/**
 * Runtime state for a single profile's Chrome instance.
 */
type ProfileRuntimeState = {
  profile: ResolvedBrowserProfile;
  running: RunningChrome | null;
  ensureBrowserAvailable?: {
    key: string;
    promise: Promise<void>;
  } | null;
  managedLaunchFailure?: {
    consecutiveFailures: number;
    lastFailureAt: number;
    cooldownUntil?: number;
    lastError: string;
  }; /** Sticky tab selection when callers omit targetId (keeps snapshot+act consistent). */
  lastTargetId?: string | null; /** Stable, user-facing tab aliases scoped to this profile runtime. */
  tabAliases?: {
    nextTabNumber: number;
    byTargetId: Record<string, {
      tabId: string;
      label?: string;
      url?: string;
    }>;
  };
  reconcile?: {
    previousProfile: ResolvedBrowserProfile;
    reason: string;
  } | null;
};
type BrowserServerState = {
  server?: Server | null;
  port: number;
  resolved: ResolvedBrowserConfig;
  profiles: Map<string, ProfileRuntimeState>;
  stopTrackedTabCleanup?: () => void;
  stopUnhandledRejectionHandler?: () => void;
};
type BrowserProfileActions = {
  ensureBrowserAvailable: (opts?: {
    headless?: boolean;
  }) => Promise<void>;
  ensureTabAvailable: (targetId?: string) => Promise<BrowserTab>;
  isHttpReachable: (timeoutMs?: number) => Promise<boolean>;
  isTransportAvailable: (timeoutMs?: number) => Promise<boolean>;
  isReachable: (timeoutMs?: number, options?: {
    ephemeral?: boolean;
    signal?: AbortSignal;
  }) => Promise<boolean>;
  listTabs: () => Promise<BrowserTab[]>;
  openTab: (url: string, opts?: {
    label?: string;
  }) => Promise<BrowserTab>;
  labelTab: (targetId: string, label: string) => Promise<BrowserTab>;
  focusTab: (targetId: string) => Promise<void>;
  closeTab: (targetId: string) => Promise<void>;
  stopRunningBrowser: () => Promise<{
    stopped: boolean;
  }>;
  resetProfile: () => Promise<{
    moved: boolean;
    from: string;
    to?: string;
  }>;
};
type BrowserRouteContext = {
  state: () => BrowserServerState;
  forProfile: (profileName?: string) => ProfileContext;
  listProfiles: () => Promise<ProfileStatus[]>;
  mapTabError: (err: unknown) => {
    status: number;
    message: string;
  } | null;
} & BrowserProfileActions;
type ProfileContext = {
  profile: ResolvedBrowserProfile;
} & BrowserProfileActions;
type ProfileStatus = {
  name: string;
  transport: BrowserTransport;
  cdpPort: number | null;
  cdpUrl: string | null;
  color: string;
  driver: ResolvedBrowserProfile["driver"];
  running: boolean;
  tabCount: number;
  isDefault: boolean;
  isRemote: boolean;
  missingFromConfig?: boolean;
  reconcileReason?: string | null;
};
type ContextOptions = {
  getState: () => BrowserServerState | null;
  onEnsureAttachTarget?: (profile: ResolvedBrowserProfile) => Promise<void>;
  refreshConfigFromDisk?: boolean;
};
//#endregion
//#region extensions/browser/src/browser/server-context.d.ts
declare function createBrowserRouteContext(opts: ContextOptions): BrowserRouteContext;
//#endregion
//#region extensions/browser/src/browser/bridge-server.d.ts
type BrowserBridge = {
  server: Server;
  port: number;
  baseUrl: string;
  state: BrowserServerState;
};
type ResolvedNoVncObserver = {
  noVncPort: number;
  password?: string;
};
declare function startBrowserBridgeServer(params: {
  resolved: ResolvedBrowserConfig;
  host?: string;
  port?: number;
  authToken?: string;
  authPassword?: string;
  onEnsureAttachTarget?: (profile: ProfileContext["profile"]) => Promise<void>;
  resolveSandboxNoVncToken?: (token: string) => ResolvedNoVncObserver | null;
  skipRouteRegistrationForTest?: boolean;
}): Promise<BrowserBridge>;
declare function stopBrowserBridgeServer(server: Server): Promise<void>;
//#endregion
export { BrowserRouteContext as a, BrowserTab as c, createBrowserRouteContext as i, BrowserTransport as l, startBrowserBridgeServer as n, BrowserServerState as o, stopBrowserBridgeServer as r, BrowserStatus as s, BrowserBridge as t, SnapshotAriaNode as u };