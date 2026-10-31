import type { ResolvedBrowserProfile } from "./config.js";
import { resolveBrowserEngine } from "./engines/registry.js";
import type { BrowserProfileCapabilities } from "./engines/types.js";

export type { BrowserProfileCapabilities } from "./engines/types.js";

export function getBrowserProfileCapabilities(
  profile: ResolvedBrowserProfile,
): BrowserProfileCapabilities {
  return resolveBrowserEngine(profile.engine).capabilities(profile);
}
