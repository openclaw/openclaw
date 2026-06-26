// Discord API module exposes the plugin public contract.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

type DiscordSubagentHooksModule = typeof import("./src/subagent-hooks.js");
type DiscordSubagentProgressModule = typeof import("./src/subagent-progress.js");

let discordSubagentHooksPromise: Promise<DiscordSubagentHooksModule> | null = null;
let discordSubagentProgressPromise: Promise<DiscordSubagentProgressModule> | null = null;

function loadDiscordSubagentHooksModule() {
  discordSubagentHooksPromise ??= import("./src/subagent-hooks.js");
  return discordSubagentHooksPromise;
}

function loadDiscordSubagentProgressModule() {
  discordSubagentProgressPromise ??= import("./src/subagent-progress.js");
  return discordSubagentProgressPromise;
}

// Subagent hooks live behind a dedicated barrel so the bundled entry can
// register one stable hook wiring path while keeping the handler module lazy.
export function registerDiscordSubagentHooks(api: OpenClawPluginApi): void {
  api.on("subagent_spawned", async (event) => {
    const { handleDiscordSubagentProgressSpawned } = await loadDiscordSubagentProgressModule();
    await handleDiscordSubagentProgressSpawned(api, event);
  });
  api.on("subagent_ended", async (event) => {
    const { handleDiscordSubagentEnded } = await loadDiscordSubagentHooksModule();
    handleDiscordSubagentEnded(event);
  });
  api.on("subagent_delivery_target", async (event) => {
    const { handleDiscordSubagentDeliveryTarget } = await loadDiscordSubagentHooksModule();
    return handleDiscordSubagentDeliveryTarget(event);
  });
}
