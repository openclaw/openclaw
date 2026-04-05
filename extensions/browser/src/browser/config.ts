export {
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  DEFAULT_BROWSER_DEFAULT_PROFILE_NAME,
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
  parseBrowserHttpUrl,
  redactCdpUrl,
  resolveBrowserConfig,
  resolveBrowserControlAuth,
  resolveProfile,
  type BrowserControlAuth,
  type ResolvedBrowserConfig,
  type ResolvedBrowserProfile,
} from "openclaw/plugin-sdk/browser-config";
export { parseBrowserHttpUrl as parseHttpUrl } from "openclaw/plugin-sdk/browser-config";

export function shouldStartLocalBrowserServer(_resolved: unknown) {
  return true;
}
