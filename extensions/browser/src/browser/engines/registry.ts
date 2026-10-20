import { lightpandaEngine } from "./lightpanda.js";
import type { BrowserEngineAdapter, BrowserEngineDescriptor, BrowserEngineId } from "./types.js";

const chromiumEngine: BrowserEngineAdapter = {
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
      supportsConsole: true,
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
      // A loopback attach-only endpoint can terminate in Docker or a tunnel, and a
      // Store-installed extension's chrome.debugger client cannot read local files.
      // Only an OpenClaw-owned local-managed browser is known to share this filesystem.
      // Extension uploads therefore go through the byte-payload branch so no local path
      // reaches DOM.setFileInputFiles (which Chrome rejects for packed extensions).
      browserFilesystemLocal: localManaged && !profile.attachOnly,
      usesChromeMcp,
      usesPersistentPlaywright: usesExtension || isRemote,
      supportsPerTabWs: localManaged,
      supportsReset: localManaged,
      supportsManagedTabLimit: localManaged,
    };
  },
};

// The Browser plugin owns this fixed registry. Register both implementations
// here; selection never loads a second tool, process manager, or plugin runtime.
const engines: Readonly<Record<BrowserEngineId, BrowserEngineAdapter>> = {
  chromium: chromiumEngine,
  lightpanda: lightpandaEngine,
};

export function resolveBrowserEngine(id: BrowserEngineId = "chromium"): BrowserEngineAdapter {
  if (!Object.hasOwn(engines, id)) {
    throw new Error(`Unknown browser engine "${id}". Select chromium or lightpanda.`);
  }
  return engines[id];
}

/** The same registered implementations drive status discovery and execution. */
export function listBrowserEngines(): BrowserEngineDescriptor[] {
  return Object.values(engines).map(({ descriptor }) => Object.assign({}, descriptor));
}
