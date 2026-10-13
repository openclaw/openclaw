import type { BrowserProfileConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedBrowserProfile } from "../profile.types.js";

export type BrowserEngineId = NonNullable<BrowserProfileConfig["engine"]>;

type BrowserProfileMode =
  | "local-managed"
  | "local-existing-session"
  | "local-extension"
  | "lightweight-cdp"
  | "remote-cdp";

export type BrowserProfileCapabilities = {
  mode: BrowserProfileMode;
  isRemote: boolean;
  /** Browser process reads paths from the same filesystem as OpenClaw. */
  browserFilesystemLocal: boolean;
  /** Profile uses the Chrome DevTools MCP server (existing-session driver). */
  usesChromeMcp: boolean;
  usesPersistentPlaywright: boolean;
  supportsPerTabWs: boolean;
  supportsJsonTabEndpoints: boolean;
  supportsReset: boolean;
  supportsManagedTabLimit: boolean;
  supportsBatchActions: boolean;
  supportsDownloads: boolean;
  supportsPdf: boolean;
  supportsRequests: boolean;
  supportsErrors: boolean;
  supportsPageText: boolean;
  supportsEmulation: boolean;
  supportsScreenshots: boolean;
  supportsVisualActions: boolean;
  supportsUploads: boolean;
  supportsDialogs: boolean;
  supportsStorage: boolean;
  supportsScreencast: boolean;
  supportsConsole: boolean;
  supportsMultipleTabs: boolean;
  /** Supports native CDP accessibility/role snapshot formats and scoped snapshots. */
  supportsNativeSnapshots: boolean;
  requiresCompleteTargetEnumeration: boolean;
};

export type BrowserEngineDescriptor = {
  id: BrowserEngineId;
  label: string;
  launchMode: "managed-or-attach" | "attach-only";
  sessionScope: "browser" | "connection";
  screenshotFidelity: "rendered" | "none";
};

type BrowserEngineCdpNormalizer = {
  send: (message: object) => object;
  receive: (message: Record<string, unknown>) => Record<string, unknown> | undefined;
  clear: () => void;
};

/** Engine behavior only. Browser sessions, navigation policy and tools keep their existing owners. */
export type BrowserEngineAdapter = {
  descriptor: Readonly<BrowserEngineDescriptor>;
  requiresDedicatedEndpoint: boolean;
  canReconnectForSafeReads: boolean;
  maxPagesPerConnection?: number;
  defaultSnapshotRefs?: "aria" | "role";
  capabilities: (profile: ResolvedBrowserProfile) => BrowserProfileCapabilities;
  /** Engines with their own external launch protocol validate and resolve their profile here. */
  resolveExternalProfile?: (name: string, profile: BrowserProfileConfig) => ResolvedBrowserProfile;
  supportsRequest: (request: {
    path: string;
    actionKind?: string;
    actionSelector?: string;
    snapshot?: { labels: boolean; format: string; refs: string; selector: string; frame: string };
  }) => boolean;
  createCdpNormalizer?: () => BrowserEngineCdpNormalizer;
};
