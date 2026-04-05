export {
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  DEFAULT_BROWSER_DEFAULT_PROFILE_NAME,
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
  resolveBrowserConfig,
  resolveProfile,
  type ResolvedBrowserConfig,
  type ResolvedBrowserProfile,
} from "openclaw/plugin-sdk/browser-profiles";
export { parseBrowserHttpUrl, redactCdpUrl } from "openclaw/plugin-sdk/browser-cdp";
export type { BrowserControlAuth } from "openclaw/plugin-sdk/browser-control-auth";
export { resolveBrowserControlAuth } from "openclaw/plugin-sdk/browser-control-auth";
export { parseBrowserHttpUrl as parseHttpUrl } from "openclaw/plugin-sdk/browser-cdp";

export function shouldStartLocalBrowserServer(_resolved: unknown) {
  return true;
}
