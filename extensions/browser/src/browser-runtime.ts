export {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserConsoleMessages,
  browserNavigate,
  browserPdfSave,
  browserScreenshotAction,
} from "./browser/client-actions.js";
export {
  browserCloseTab,
  browserFocusTab,
  browserOpenTab,
  browserCreateProfile,
  browserDeleteProfile,
  browserProfiles,
  browserResetProfile,
  browserSnapshot,
  browserStart,
  browserStatus,
  browserStop,
  browserTabAction,
  browserTabs,
} from "./browser/client.js";
export type {
  BrowserCreateProfileResult,
  BrowserDeleteProfileResult,
  BrowserResetProfileResult,
  BrowserStatus,
  BrowserTab,
  BrowserTransport,
  ProfileStatus,
  SnapshotResult,
} from "./browser/client.js";
export { resolveBrowserConfig, resolveProfile } from "./browser/config.js";
export { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "./browser/constants.js";
export { redactCdpUrl } from "./browser/cdp.helpers.js";
export { DEFAULT_UPLOAD_DIR, resolveExistingPathsWithinRoot } from "./browser/paths.js";
export { getBrowserProfileCapabilities } from "./browser/profile-capabilities.js";
export { applyBrowserProxyPaths, persistBrowserProxyFiles } from "./browser/proxy-files.js";
export {
  isPersistentBrowserProfileMutation,
  normalizeBrowserRequestPath,
  resolveRequestedBrowserProfile,
} from "./browser/request-policy.js";
export {
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./browser/session-tab-registry.js";
export { ensureBrowserControlAuth, resolveBrowserControlAuth } from "./browser/control-auth.js";
export {
  createBrowserControlContext,
  getBrowserControlState,
  startBrowserControlServiceFromConfig,
  stopBrowserControlService,
} from "./control-service.js";
export { createBrowserRuntimeState, stopBrowserRuntime } from "./browser/runtime-lifecycle.js";
export { type BrowserServerState, createBrowserRouteContext } from "./browser/server-context.js";
export { registerBrowserRoutes } from "./browser/routes/index.js";
export { createBrowserRouteDispatcher } from "./browser/routes/dispatcher.js";
export type { BrowserRouteRegistrar } from "./browser/routes/types.js";
export {
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
} from "./browser/server-middleware.js";
export type { BrowserFormField } from "./browser/client-actions-core.js";
export {
  normalizeBrowserFormField,
  normalizeBrowserFormFieldValue,
} from "./browser/form-fields.js";
