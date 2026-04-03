export {
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  DEFAULT_BROWSER_DEFAULT_PROFILE_NAME,
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
} from "./src/browser/constants.js";
export type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./src/browser/config.js";
export {
  parseHttpUrl as parseBrowserHttpUrl,
  resolveBrowserConfig,
  resolveProfile,
} from "./src/browser/config.js";
export { redactCdpUrl } from "./src/browser/cdp.helpers.js";
export { DEFAULT_UPLOAD_DIR } from "./src/browser/paths.js";
export type { BrowserControlAuth } from "./src/browser/control-auth.js";
export { resolveBrowserControlAuth } from "./src/browser/control-auth.js";
