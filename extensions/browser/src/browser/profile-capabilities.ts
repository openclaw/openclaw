import type { ResolvedBrowserProfile } from "./config.js";
import { resolveBrowserEngine } from "./engines/registry.js";
import type { BrowserProfileCapabilities } from "./engines/types.js";

export type { BrowserProfileCapabilities } from "./engines/types.js";

export function getBrowserProfileCapabilities(
  profile: ResolvedBrowserProfile,
): BrowserProfileCapabilities {
  return resolveBrowserEngine(profile.engine).capabilities(profile);
}

/** External CDP endpoints may be attached on loopback as well as over a network. */
export function isExternallyManagedCdpProfile(profile: ResolvedBrowserProfile): boolean {
  return (
    getBrowserProfileCapabilities(profile).isRemote ||
    (profile.driver === "openclaw" && profile.attachOnly)
  );
}
