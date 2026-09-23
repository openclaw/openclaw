import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getBrowserControlState } from "./browser-control-state.js";
import { resolveBrowserExecutableForPlatform } from "./browser/chrome.executables.js";
import { isChromeReachable } from "./browser/chrome.js";
import {
  resolveBrowserConfig,
  resolveManagedBrowserHeadlessMode,
  resolveProfile,
} from "./browser/config.js";
import { getBrowserProfileCapabilities } from "./browser/profile-capabilities.js";
import { getRuntimeConfigSourceSnapshot } from "./config/config.js";

/** Inspect local capability before routing, without launching or replaying a browser action. */
export async function isBrowserHostAvailable(
  config: OpenClawConfig,
  profileName?: string,
): Promise<boolean> {
  const source = getRuntimeConfigSourceSnapshot() ?? config;
  const resolved = resolveBrowserConfig(source.browser, source);
  if (!resolved.enabled) {
    return false;
  }
  const profile = resolveProfile(resolved, profileName ?? resolved.defaultProfile);
  if (!profile) {
    return false;
  }
  // Attached browsers and configured CDP endpoints belong to this host's profile;
  // a connection failure must not substitute another browser or its login state.
  if (getBrowserProfileCapabilities(profile).mode !== "local-managed" || profile.attachOnly) {
    return true;
  }
  if (getBrowserControlState()?.profiles.get(profile.name)?.running) {
    return true;
  }
  try {
    if (
      resolveBrowserExecutableForPlatform(
        {
          ...resolved,
          executablePath: profile.executablePath,
          headless: resolveManagedBrowserHeadlessMode(resolved, profile).headless,
        },
        process.platform,
      )
    ) {
      return true;
    }
  } catch {
    // Keep invalid explicit executable settings on their owner for an actionable error.
    return true;
  }
  // A managed browser can survive control-service restart and executable replacement.
  return await isChromeReachable(profile.cdpUrl);
}
