import { isLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import { DEFAULT_OPENCLAW_BROWSER_COLOR } from "../constants.js";
import { createLightpandaCdpNormalizer } from "./lightpanda-cdp.js";
import type { BrowserEngineAdapter } from "./types.js";

// The experimental engine has a deliberately small, verified surface. Unknown
// routes fail closed so future Chromium features are not advertised accidentally.
const SEMANTIC_ROUTES = new Set([
  "/",
  "/doctor",
  "/start",
  "/stop",
  "/tabs",
  "/tabs/open",
  "/tabs/focus",
  "/tabs/:targetId",
  "/tabs/action",
  "/navigate",
  "/text",
  "/snapshot",
  "/act",
]);
const SEMANTIC_ACT_KINDS = new Set([
  "click",
  "type",
  "press",
  "select",
  "fill",
  "wait",
  "evaluate",
  "close",
]);

export const lightpandaEngine: BrowserEngineAdapter = {
  descriptor: {
    id: "lightpanda",
    label: "Lightpanda",
    launchMode: "attach-only",
    sessionScope: "connection",
    screenshotFidelity: "none",
  },
  requiresDedicatedEndpoint: true,
  canReconnectForSafeReads: false,
  maxPagesPerConnection: 1,
  defaultSnapshotRefs: "aria",
  createCdpNormalizer: createLightpandaCdpNormalizer,
  supportsRequest({ path, actionKind, actionSelector, snapshot }) {
    if (!SEMANTIC_ROUTES.has(path)) {
      return false;
    }
    if (path === "/act") {
      return !actionSelector && (actionKind === undefined || SEMANTIC_ACT_KINDS.has(actionKind));
    }
    return (
      !snapshot ||
      !(
        snapshot.labels ||
        snapshot.format === "aria" ||
        snapshot.refs === "role" ||
        snapshot.selector ||
        snapshot.frame
      )
    );
  },
  capabilities(profile) {
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
  },
  resolveExternalProfile(profileName, profile) {
    // Also validate here: callers can resolve programmatic config without
    // passing through the persisted-config schema first.
    const endpoint = profile.cdpUrl ? URL.parse(profile.cdpUrl) : null;
    if (!endpoint || !["ws:", "wss:"].includes(endpoint.protocol)) {
      throw new Error(
        `browser.profiles.${profileName}.cdpUrl must be an explicit ws:// or wss:// Lightpanda endpoint.`,
      );
    }
    if (profile.attachOnly !== true) {
      throw new Error(`browser.profiles.${profileName} requires attachOnly: true for Lightpanda.`);
    }
    if (profile.driver !== undefined && profile.driver !== "openclaw") {
      throw new Error(
        `browser.profiles.${profileName} requires the default CDP driver for Lightpanda.`,
      );
    }
    for (const key of [
      "cdpPort",
      "userDataDir",
      "mcpCommand",
      "mcpArgs",
      "headless",
      "executablePath",
    ] as const) {
      if (profile[key] !== undefined) {
        throw new Error(`browser.profiles.${profileName}.${key} is not supported by Lightpanda.`);
      }
    }
    return {
      name: profileName,
      engine: "lightpanda",
      cdpUrl: endpoint.toString(),
      cdpHost: endpoint.hostname,
      cdpPort: Number(endpoint.port || (endpoint.protocol === "wss:" ? 443 : 80)),
      cdpIsLoopback: isLoopbackHost(endpoint.hostname),
      color: DEFAULT_OPENCLAW_BROWSER_COLOR,
      driver: "openclaw",
      headless: true,
      headlessSource: "default",
      attachOnly: true,
    };
  },
};
