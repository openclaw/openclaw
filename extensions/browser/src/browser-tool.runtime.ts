import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
/**
 * Runtime dependency barrel for the Browser agent tool.
 *
 * Kept separate from browser-tool.ts so tests can mock the tool boundary while
 * production still imports SDK helpers and browser client actions lazily.
 */
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";

export { getRuntimeConfig };
/** Resolve global image downscaling for screenshots returned to agent tools. */
export function resolveRuntimeImageSanitization(): { maxDimensionPx: number } | undefined {
  const maxDimensionPx = resolveOptionalIntegerOption(
    getRuntimeConfig().agents?.defaults?.imageMaxDimensionPx,
    { min: 1 },
  );
  if (maxDimensionPx === undefined) {
    return undefined;
  }
  return { maxDimensionPx };
}
export {
  callGatewayTool,
  readGatewayToolOperatorScopes,
  hasGatewayToolRoutingContext,
  listNodes,
} from "openclaw/plugin-sdk/agent-harness-runtime";
export type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
export {
  imageResultFromFile,
  jsonResult,
  readPositiveIntegerParam,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
export { saveMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
export { describeImageFile } from "openclaw/plugin-sdk/media-understanding-runtime";
export { wrapExternalContent } from "openclaw/plugin-sdk/security-runtime";
export {
  normalizeOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
export type { BrowserToolCapabilities } from "./browser-tool.schema.js";
export {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserConsoleMessages,
  browserRequests,
  browserErrors,
  browserPageText,
  browserEmulateSetting,
  browserDownload,
  browserNavigate,
  browserPdfSave,
  browserScreenshotAction,
  browserWaitForDownload,
} from "./browser/client-actions.js";
export {
  browserCloseTab,
  browserDoctor,
  browserFocusTab,
  browserImportProfile,
  browserOpenTab,
  browserProfiles,
  browserSystemProfiles,
  browserSnapshot,
  browserStart,
  browserStatus,
  browserStop,
  browserTabs,
} from "./browser/client.js";
export type { BrowserTabsResult } from "./browser/client.js";
export { fetchBrowserJson } from "./browser/client-fetch.js";
export { resolveBrowserConfig, resolveProfile } from "./browser/config.js";
export { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "./browser/constants.js";
export { resolveExistingUploadPaths } from "./browser/paths.js";
export { getBrowserProfileCapabilities } from "./browser/profile-capabilities.js";
export { persistBrowserProxyResultFiles } from "./browser/proxy-files.js";
export { stageBrowserScreenshotForSharing } from "./browser/screenshot-sharing.js";
export {
  touchSessionBrowserTab,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./browser/session-tab-registry.js";
