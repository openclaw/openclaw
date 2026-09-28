/**
 * Browser profile capability resolution.
 *
 * Derives transport and driver capability flags used by routes and the Browser
 * tool to choose CDP, Playwright, or Chrome MCP behavior.
 */
import type { ResolvedBrowserProfile } from "./config.js";
import { resolveBrowserEngine } from "./engines/registry.js";
import type { BrowserProfileCapabilities } from "./engines/types.js";

export type { BrowserProfileCapabilities } from "./engines/types.js";

/** Resolve capabilities through the selected engine inside the Browser plugin. */
export function getBrowserProfileCapabilities(
  profile: ResolvedBrowserProfile,
): BrowserProfileCapabilities {
  return resolveBrowserEngine(profile.engine).capabilities(profile);
}

/** Resolve the default snapshot format for a profile and available drivers. */
export function resolveDefaultSnapshotFormat(params: {
  profile: ResolvedBrowserProfile;
  hasPlaywright: boolean;
  explicitFormat?: "ai" | "aria";
  mode?: "efficient";
}): "ai" | "aria" {
  if (params.explicitFormat) {
    return params.explicitFormat;
  }
  if (params.mode === "efficient") {
    return "ai";
  }

  const capabilities = getBrowserProfileCapabilities(params.profile);
  if (capabilities.mode === "local-existing-session") {
    return "ai";
  }

  return params.hasPlaywright ? "ai" : "aria";
}

/** Return true when screenshots should use Playwright for the profile. */
export function shouldUsePlaywrightForScreenshot(params: {
  profile: ResolvedBrowserProfile;
  wsUrl?: string;
  ref?: string;
  element?: string;
}): boolean {
  return !params.wsUrl || Boolean(params.ref) || Boolean(params.element);
}

/** Return true when ARIA snapshots should use Playwright for the profile. */
export function shouldUsePlaywrightForAriaSnapshot(params: {
  profile: ResolvedBrowserProfile;
  wsUrl?: string;
}): boolean {
  return !params.wsUrl;
}
