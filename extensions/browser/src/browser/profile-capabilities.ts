/**
 * Browser profile capability resolution.
 *
 * Derives transport and driver capability flags used by routes and the Browser
 * tool to choose CDP, Playwright, or Chrome MCP behavior.
 */
import type { ResolvedBrowserProfile } from "./config.js";

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

/** Return feature capabilities for a resolved browser profile. */
export function getBrowserProfileCapabilities(
  profile: ResolvedBrowserProfile,
): BrowserProfileCapabilities {
  if (profile.engine === "lightpanda") {
    // Lightpanda owns one target per live connection, including loopback and
    // Docker endpoints. A successful CDP handshake is not Chromium parity.
    return {
      mode: "lightweight-cdp",
      isRemote: !profile.cdpIsLoopback,
      browserFilesystemLocal: false,
      usesChromeMcp: false,
      usesPersistentPlaywright: true,
      supportsPerTabWs: false,
      supportsJsonTabEndpoints: false,
      supportsReset: false,
      supportsManagedTabLimit: false,
      supportsBatchActions: false,
      supportsDownloads: false,
      supportsPdf: false,
      supportsRequests: false,
      supportsErrors: false,
      supportsPageText: true,
      supportsEmulation: false,
      supportsScreenshots: false,
      supportsVisualActions: false,
      supportsUploads: false,
      supportsDialogs: false,
      supportsStorage: false,
      supportsScreencast: false,
      supportsConsole: false,
      supportsMultipleTabs: false,
      supportsNativeSnapshots: false,
      requiresCompleteTargetEnumeration: false,
    };
  }
  const driverCapabilities = {
    supportsBatchActions: profile.driver !== "existing-session",
    supportsDownloads: profile.driver !== "existing-session",
    supportsPdf: profile.driver !== "existing-session",
    supportsRequests: profile.driver !== "existing-session",
    supportsErrors: profile.driver !== "existing-session",
    supportsPageText: profile.driver !== "existing-session",
    supportsEmulation: profile.driver !== "existing-session",
    supportsScreenshots: true,
    supportsVisualActions: true,
    supportsUploads: true,
    supportsDialogs: true,
    supportsStorage: true,
    supportsScreencast: profile.driver !== "existing-session",
    supportsConsole: true,
    supportsMultipleTabs: true,
    supportsNativeSnapshots: true,
    requiresCompleteTargetEnumeration: profile.driver === "extension",
  };
  if (profile.driver === "existing-session") {
    return {
      ...driverCapabilities,
      mode: "local-existing-session",
      isRemote: false,
      browserFilesystemLocal: false,
      usesChromeMcp: true,
      usesPersistentPlaywright: false,
      supportsPerTabWs: false,
      supportsJsonTabEndpoints: false,
      supportsReset: false,
      supportsManagedTabLimit: false,
    };
  }

  // Extension relay profiles drive the user's signed-in browser through the
  // paired Chrome extension. Ops run over persistent Playwright exactly like
  // remote CDP, but the endpoint is the loopback relay server.
  if (profile.driver === "extension") {
    return {
      ...driverCapabilities,
      mode: "local-extension",
      isRemote: false,
      browserFilesystemLocal: true,
      usesChromeMcp: false,
      usesPersistentPlaywright: true,
      supportsPerTabWs: false,
      supportsJsonTabEndpoints: false,
      supportsReset: false,
      supportsManagedTabLimit: false,
    };
  }

  if (!profile.cdpIsLoopback) {
    return {
      ...driverCapabilities,
      mode: "remote-cdp",
      isRemote: true,
      browserFilesystemLocal: false,
      usesChromeMcp: false,
      usesPersistentPlaywright: true,
      supportsPerTabWs: false,
      supportsJsonTabEndpoints: false,
      supportsReset: false,
      supportsManagedTabLimit: false,
    };
  }

  return {
    ...driverCapabilities,
    mode: "local-managed",
    isRemote: false,
    // A loopback attach-only endpoint can terminate in Docker or a tunnel.
    // Only an OpenClaw-owned browser is known to share this filesystem.
    browserFilesystemLocal: !profile.attachOnly,
    usesChromeMcp: false,
    usesPersistentPlaywright: false,
    supportsPerTabWs: true,
    supportsJsonTabEndpoints: true,
    supportsReset: true,
    supportsManagedTabLimit: true,
  };
}

/** Resolve the default snapshot format for a profile and available drivers. */
export function resolveDefaultSnapshotFormat(params: {
  profile: ResolvedBrowserProfile;
  hasPlaywright: boolean;
  explicitFormat?: "ai" | "aria";
  mode?: "efficient";
}): "ai" | "aria" {
  if (params.explicitFormat) {
    return params.explicitFormat;
  }
  if (params.mode === "efficient") {
    return "ai";
  }

  const capabilities = getBrowserProfileCapabilities(params.profile);
  if (capabilities.mode === "local-existing-session") {
    return "ai";
  }

  return params.hasPlaywright ? "ai" : "aria";
}

/** Return true when screenshots should use Playwright for the profile. */
export function shouldUsePlaywrightForScreenshot(params: {
  profile: ResolvedBrowserProfile;
  wsUrl?: string;
  ref?: string;
  element?: string;
}): boolean {
  return !params.wsUrl || Boolean(params.ref) || Boolean(params.element);
}

/** Return true when ARIA snapshots should use Playwright for the profile. */
export function shouldUsePlaywrightForAriaSnapshot(params: {
  profile: ResolvedBrowserProfile;
  wsUrl?: string;
}): boolean {
  return !params.wsUrl;
}
