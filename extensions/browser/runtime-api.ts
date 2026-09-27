export { createBrowserTool } from "./src/browser-tool.js";
export {
  createAttachedBrowserToolRuntime,
  type AttachedBrowserToolRuntime,
  type CreateAttachedBrowserToolRuntimeParams,
} from "./src/attached-browser-tool-runtime.js";
export { startBrowserBridgeServer, stopBrowserBridgeServer } from "./src/browser/bridge-server.js";
export type { BrowserBridge } from "./src/browser/bridge-server.js";
export {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserConsoleMessages,
  browserNavigate,
  browserPdfSave,
  browserScreenshotAction,
} from "./src/browser/client-actions.js";
export {
  browserCloseTab,
  browserFocusTab,
  browserOpenTab,
  browserCreateProfile,
  browserDeleteProfile,
  browserDoctor,
  browserProfiles,
  browserResetProfile,
  browserSnapshot,
  browserStart,
  browserStatus,
  browserStop,
  browserTabAction,
  browserTabs,
} from "./src/browser/client.js";
export { runBrowserProxyCommand } from "./src/node-host/invoke-browser.js";
export type {
  BrowserCreateProfileResult,
  BrowserDeleteProfileResult,
  BrowserDoctorCheck,
  BrowserDoctorReport,
  BrowserResetProfileResult,
  BrowserStatus,
  BrowserTab,
  BrowserTransport,
  ProfileStatus,
  SnapshotResult,
} from "./src/browser/client.js";
export type { BrowserExecutable } from "./src/browser/chrome.executables.js";
export type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./src/browser/config.js";
export { resolveBrowserConfig, resolveProfile } from "./src/browser/config.js";
export {
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
} from "./src/browser/constants.js";
export {
  parseBrowserMajorVersion,
  readBrowserVersion,
} from "./src/browser/chrome.executable-probe.js";
export { resolveGoogleChromeExecutableForPlatform } from "./src/browser/chrome.executables.js";
export { redactCdpUrl } from "./src/browser/cdp.helpers.js";
export { DEFAULT_UPLOAD_DIR, resolveExistingPathsWithinRoot } from "./src/browser/paths.js";
export { getBrowserProfileCapabilities } from "./src/browser/profile-capabilities.js";
export {
  isPersistentBrowserProfileMutation,
  normalizeBrowserRequestPath,
  resolveRequestedBrowserProfile,
} from "./src/browser/request-policy.js";
export {
  closeTrackedBrowserTabsForSessions,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./src/browser/session-tab-registry.js";
export { ensureBrowserControlAuth, resolveBrowserControlAuth } from "./src/browser/control-auth.js";
export { movePathToTrash } from "./src/browser/trash.js";
export {
  createBrowserControlContext,
  getBrowserControlState,
  startBrowserControlServiceFromConfig,
  stopBrowserControlService,
} from "./src/control-service.js";
export { createBrowserRuntimeState, stopBrowserRuntime } from "./src/browser/runtime-lifecycle.js";
export {
  type BrowserServerState,
  createBrowserRouteContext,
} from "./src/browser/server-context.js";
export { registerBrowserRoutes } from "./src/browser/routes/index.js";
export { createBrowserRouteDispatcher } from "./src/browser/routes/dispatcher.js";
export type { BrowserRouteRegistrar } from "./src/browser/routes/types.js";
export {
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
} from "./src/browser/server-middleware.js";
export type { BrowserFormField } from "./src/browser/client-actions-core.js";
export {
  normalizeBrowserFormField,
  normalizeBrowserFormFieldValue,
} from "./src/browser/form-fields.js";
export { registerBrowserCli } from "./src/cli/browser-cli.js";
export { createBrowserPluginService } from "./src/plugin-service.js";
export { handleBrowserGatewayRequest } from "./src/gateway/browser-request.js";
export { browserHandlers } from "./src/gateway/browser-request.js";
export {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
  type OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
