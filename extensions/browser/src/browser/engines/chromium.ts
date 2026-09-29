import type { BrowserEngineAdapter } from "./types.js";

export const chromiumEngine: BrowserEngineAdapter = {
  descriptor: {
    id: "chromium",
    label: "Chromium",
    launchMode: "managed-or-attach",
    sessionScope: "browser",
    screenshotFidelity: "rendered",
  },
  requiresDedicatedEndpoint: false,
  canReconnectForSafeReads: true,
  supportsRequest: () => true,
  capabilities(profile) {
    const usesChromeMcp = profile.driver === "existing-session";
    const usesExtension = profile.driver === "extension";
    const isRemote = !usesChromeMcp && !usesExtension && !profile.cdpIsLoopback;
    const localManaged = !usesChromeMcp && !usesExtension && !isRemote;
    return {
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
      mode: usesChromeMcp
        ? "local-existing-session"
        : usesExtension
          ? "local-extension"
          : isRemote
            ? "remote-cdp"
            : "local-managed",
      isRemote,
      // A loopback attach-only endpoint can terminate in Docker or a tunnel.
      // Only an OpenClaw-owned browser is known to share this filesystem.
      browserFilesystemLocal: usesExtension || (localManaged && !profile.attachOnly),
      usesChromeMcp,
      usesPersistentPlaywright: usesExtension || isRemote,
      supportsPerTabWs: localManaged,
      supportsJsonTabEndpoints: localManaged,
      supportsReset: localManaged,
      supportsManagedTabLimit: localManaged,
    };
  },
};
