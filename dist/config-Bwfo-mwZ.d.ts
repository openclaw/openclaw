import { Tt as BrowserProfileConfig, i as OpenClawConfig, wt as BrowserConfig } from "./types.openclaw-BLF4DJTX.js";
import { o as SsrFPolicy } from "./ssrf-skjEI_i5.js";
//#region extensions/browser/src/browser/constants.d.ts
declare const DEFAULT_OPENCLAW_BROWSER_ENABLED = true;
declare const DEFAULT_BROWSER_EVALUATE_ENABLED = true;
declare const DEFAULT_OPENCLAW_BROWSER_COLOR = "#FF4500";
declare const DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME = "openclaw";
declare const DEFAULT_BROWSER_DEFAULT_PROFILE_NAME = "openclaw";
declare const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 60000;
declare const DEFAULT_AI_SNAPSHOT_MAX_CHARS = 40000;
//#endregion
//#region extensions/browser/src/browser/paths.d.ts
declare const DEFAULT_UPLOAD_DIR: string;
//#endregion
//#region extensions/browser/src/browser/config.d.ts
type ResolvedBrowserConfig = {
  enabled: boolean;
  evaluateEnabled: boolean;
  controlPort: number;
  cdpPortRangeStart: number;
  cdpPortRangeEnd: number;
  cdpProtocol: "http" | "https";
  cdpHost: string;
  cdpIsLoopback: boolean;
  remoteCdpTimeoutMs: number;
  remoteCdpHandshakeTimeoutMs: number;
  localLaunchTimeoutMs: number;
  localCdpReadyTimeoutMs: number;
  actionTimeoutMs: number;
  color: string;
  executablePath?: string;
  headless: boolean;
  headlessSource?: "config" | "default";
  noSandbox: boolean;
  attachOnly: boolean;
  defaultProfile: string;
  profiles: Record<string, BrowserProfileConfig>;
  tabCleanup: ResolvedBrowserTabCleanupConfig;
  ssrfPolicy?: SsrFPolicy;
  extraArgs: string[];
};
type ResolvedBrowserTabCleanupConfig = {
  enabled: boolean;
  idleMinutes: number;
  maxTabsPerSession: number;
  sweepMinutes: number;
};
type ResolvedBrowserProfile = {
  name: string;
  cdpPort: number;
  cdpUrl: string;
  cdpHost: string;
  cdpIsLoopback: boolean;
  userDataDir?: string;
  mcpCommand?: string;
  mcpArgs?: string[];
  color: string;
  driver: "openclaw" | "existing-session";
  executablePath?: string;
  headless: boolean;
  headlessSource?: "profile" | "config" | "default";
  attachOnly: boolean;
};
type ManagedBrowserHeadlessSource = "request" | "env" | "profile" | "config" | "linux-display-fallback" | "default";
declare function resolveBrowserConfig(cfg: BrowserConfig | undefined, rootConfig?: OpenClawConfig): ResolvedBrowserConfig;
declare function resolveProfile(resolved: ResolvedBrowserConfig, profileName: string): ResolvedBrowserProfile | null;
//#endregion
export { resolveBrowserConfig as a, DEFAULT_AI_SNAPSHOT_MAX_CHARS as c, DEFAULT_BROWSER_EVALUATE_ENABLED as d, DEFAULT_OPENCLAW_BROWSER_COLOR as f, ResolvedBrowserTabCleanupConfig as i, DEFAULT_BROWSER_ACTION_TIMEOUT_MS as l, DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME as m, ResolvedBrowserConfig as n, resolveProfile as o, DEFAULT_OPENCLAW_BROWSER_ENABLED as p, ResolvedBrowserProfile as r, DEFAULT_UPLOAD_DIR as s, ManagedBrowserHeadlessSource as t, DEFAULT_BROWSER_DEFAULT_PROFILE_NAME as u };