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
    // A browser OpenClaw only attaches to drops Playwright's default-context
    // overrides (openclaw/openclaw#157547). This engine is managed-or-attach, so
    // the managed-local rule reduces to a loopback non-attach-only profile; it is
    // inlined rather than imported to avoid the import cycle
    // config -> engines/registry -> engines/chromium -> config. The reduction is
    // equivalent to config.ts isOpenClawLaunchedBrowser for chromium profiles
    // (this engine's launchMode is managed-or-attach, so the engine-side term is
    // constant), and config.test.ts's capability matrix pins that equivalence.
    const keepsDefaultContextOverrides =
      profile.driver !== "openclaw" ||
      profile.launchedByOpenClaw === true ||
      (profile.cdpIsLoopback && !profile.attachOnly);
    const driverCapabilities = {
      supportsBatchActions: profile.driver !== "existing-session",
      supportsDownloads: profile.driver !== "existing-session" && keepsDefaultContextOverrides,
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
  },
};
