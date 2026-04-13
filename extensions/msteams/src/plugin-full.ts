import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

export function registerMSTeamsFullPlugin(_api: OpenClawPluginApi): void {
  // Shared Teams interactive dispatch is wired through the monitor handler.
  // Feature branches register their own interactive namespaces on top.
}
