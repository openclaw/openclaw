import type { BrowserProfileConfig } from "openclaw/plugin-sdk/config-contracts";
import { isLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import { BROWSER_ACT_KIND_FACTS, isActKind } from "../act-kinds.js";
import { DEFAULT_OPENCLAW_BROWSER_COLOR } from "../constants.js";
import type { ResolvedBrowserProfile } from "../profile.types.js";
import type { BrowserEngineAdapter, BrowserEngineDescriptor, BrowserEngineId } from "./types.js";

// Start with semantic browsing and rendered screenshots. Other domains may
// acknowledge unsupported commands, so a CDP handshake is not proof of support.
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
export function createExternalCdpEngine(
  options: Pick<BrowserEngineDescriptor, "id" | "label"> &
    Pick<
      BrowserEngineAdapter,
      "maxPagesPerConnection" | "createCdpNormalizer" | "closePageClosesConnection"
    > & {
      screenshots?: boolean;
    },
): BrowserEngineAdapter {
  return {
    descriptor: {
      id: options.id,
      label: options.label,
      launchMode: "attach-only",
      sessionScope: "connection",
      screenshotFidelity: options.screenshots ? "rendered" : "none",
    },
    requiresDedicatedEndpoint: true,
    canReconnectForSafeReads: false,
    defaultSnapshotRefs: "aria",
    maxPagesPerConnection: options.maxPagesPerConnection,
    closePageClosesConnection: options.closePageClosesConnection,
    createCdpNormalizer: options.createCdpNormalizer,
    supportsRequest({ path, actionKind, actionSelector, snapshot }) {
      if (path === "/screenshot") {
        return options.screenshots === true;
      }
      if (path === "/operator/input") {
        // The route answers from profile capabilities with the code the panel falls back on.
        return true;
      }
      if (!SEMANTIC_ROUTES.has(path)) {
        return false;
      }
      if (path === "/act") {
        return (
          !actionSelector &&
          (actionKind === undefined ||
            (isActKind(actionKind) && BROWSER_ACT_KIND_FACTS[actionKind].semanticCdp === true))
        );
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
      // External engines own targets within a CDP connection. Rendering
      // does not imply Chromium visual-action compatibility.
      return {
        mode: "lightweight-cdp",
        isRemote: !profile.cdpIsLoopback,
        browserFilesystemLocal: false,
        usesChromeMcp: false,
        usesPersistentPlaywright: true,
        supportsPerTabWs: false,
        supportsReset: false,
        supportsManagedTabLimit: false,
        supportsBatchActions: false,
        supportsDownloads: false,
        supportsPdf: false,
        supportsRequests: false,
        supportsErrors: false,
        supportsPageText: true,
        supportsEmulation: false,
        supportsScreenshots: options.screenshots === true,
        supportsVisualActions: false,
        supportsUploads: false,
        supportsDialogs: false,
        supportsConsole: false,
        supportsNativeSnapshots: false,
        requiresCompleteTargetEnumeration: false,
      };
    },
    resolveExternalProfile: (name, profile) =>
      resolveExternalCdpProfile(options.id, options.label, name, profile),
  };
}

function resolveExternalCdpProfile(
  engine: BrowserEngineId,
  label: string,
  profileName: string,
  profile: BrowserProfileConfig,
): ResolvedBrowserProfile {
  // Also validate here: callers can resolve programmatic config without
  // passing through the persisted-config schema first.
  const endpoint = profile.cdpUrl ? URL.parse(profile.cdpUrl) : null;
  if (!endpoint || !["ws:", "wss:"].includes(endpoint.protocol)) {
    throw new Error(
      `browser.profiles.${profileName}.cdpUrl must be an explicit ws:// or wss:// ${label} endpoint.`,
    );
  }
  if (profile.attachOnly !== true) {
    throw new Error(`browser.profiles.${profileName} requires attachOnly: true for ${label}.`);
  }
  if (profile.driver !== undefined && profile.driver !== "openclaw") {
    throw new Error(
      `browser.profiles.${profileName} requires the default CDP driver for ${label}.`,
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
      throw new Error(`browser.profiles.${profileName}.${key} is not supported by ${label}.`);
    }
  }
  return {
    name: profileName,
    engine,
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
}
