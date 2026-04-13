import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { registerMSTeamsThreadApproval } from "./thread-approval.js";

export function registerMSTeamsFullPlugin(api: OpenClawPluginApi): void {
  // Teams interactive dispatch is wired through the monitor handler. Feature-
  // specific approval handlers register their own namespaces through the
  // standard plugin interactive registration surface.
  registerMSTeamsThreadApproval(api);
}
