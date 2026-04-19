/**
 * Yuanbao hook unified registration entry.
 *
 * All hook registrations (api.on / registerInternalHook) are centralized here.
 * Plugin entry only needs to call registerYuanbaoHooks(api).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { registerBootstrapPrivacyGuard } from "./bootstrap-privacy-guard.js";
import { registerInstallGuard } from "./install-guard.js";

/**
 * Register all lifecycle hooks for the yuanbao plugin.
 */
export function registerYuanbaoHooks(api: OpenClawPluginApi): void {
  // Skill / plugin pre-install check
  registerInstallGuard(api);

  // Group chat privacy guard: remove USER.md at agent:bootstrap
  registerBootstrapPrivacyGuard();
}
