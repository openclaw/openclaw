/**
 * Dynamic browser tool description builder.
 *
 * Builds a model-facing description for the browser tool that adapts to the
 * configured browser profiles. When a CDP direct-attach profile is configured
 * as the default (with attachOnly and cdpPort set), the description recommends
 * the configured default profile instead of the hardcoded "profile=user"
 * existing-session hint that fails on non-default user-data-dir setups.
 *
 * Pattern: bash-tools.descriptions.ts — read runtime config, return conditional text.
 */
import { getRuntimeConfig } from "./sdk-config.js";

/** Browser profile config shape read from runtime config. */
interface BrowserToolProfileConfig {
  cdpPort?: number;
  driver?: string;
  attachOnly?: boolean;
}

export function describeBrowserTool(opts?: {
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
}): string {
  const targetDefault = opts?.sandboxBridgeUrl ? "sandbox" : "host";
  const hostHint =
    opts?.allowHostControl === false ? "Host target blocked by policy." : "Host target allowed.";

  const config = getRuntimeConfig();
  const browserConfig = config.browser as
    | {
        defaultProfile?: string;
        profiles?: Record<string, BrowserToolProfileConfig>;
      }
    | undefined;
  const defaultProfile = browserConfig?.defaultProfile;
  const profiles = browserConfig?.profiles;
  const defaultProfileConfig = defaultProfile && profiles ? profiles[defaultProfile] : undefined;

  // A CDP attach-only profile already has login state via direct Chrome DevTools
  // Protocol attachment. In that case the model should use the configured default
  // profile rather than the "user" existing-session profile.
  const isCdpAttachDefault =
    defaultProfileConfig &&
    defaultProfileConfig.cdpPort !== undefined &&
    defaultProfileConfig.attachOnly === true;

  const profileHint = isCdpAttachDefault
    ? `The configured default profile (\`${defaultProfile}\`) already has logged-in browser state via CDP direct attach. Use it when existing logins or cookies matter.`
    : 'For the logged-in user browser, use profile="user". A supported Chromium-based browser (v144+) must be running on the selected host or browser node. Use only when existing logins/cookies matter and the user is present.';

  return [
    "Control the browser via OpenClaw's browser control server (status/start/stop/profiles/tabs/open/snapshot/screenshot/actions).",
    "Browser choice: omit profile by default for the isolated OpenClaw-managed browser (`openclaw`).",
    profileHint,
    'For existing-session profiles, omit timeoutMs on act:type, evaluate, hover, scrollIntoView, drag, select, and fill; that driver rejects per-call timeout overrides for those actions.',
    'When a node-hosted browser proxy is available, the tool may auto-route to it. Pin a node with node=<id|name> or target="node".',
    "When using refs from snapshot (e.g. e12), keep the same tab: prefer passing targetId from the snapshot response into subsequent actions (act/click/type/etc). For tab operations, targetId also accepts tabId handles (t1) and labels from action=tabs.",
    "For multi-step browser work, login checks, stale refs, duplicate tabs, or Google Meet flows, use the bundled browser-automation skill when it is available.",
    'For stable, self-resolving refs across calls, use snapshot with refs="aria" (Playwright aria-ref ids). Default refs="role" are role+name-based.',
    "Use snapshot+act for UI automation. Avoid act:wait by default; use only in exceptional cases when no reliable UI state exists.",
    `target selects browser location (sandbox|host|node). Default: ${targetDefault}.`,
    hostHint,
  ].join(" ");
}
