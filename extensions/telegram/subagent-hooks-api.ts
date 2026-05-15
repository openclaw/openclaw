import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

type TelegramSubagentHooksModule = typeof import("./src/subagent-hooks.js");

let telegramSubagentHooksPromise: Promise<TelegramSubagentHooksModule> | null = null;

function loadTelegramSubagentHooksModule() {
  telegramSubagentHooksPromise ??= import("./src/subagent-hooks.js");
  return telegramSubagentHooksPromise;
}

export function registerTelegramSubagentHooks(api: OpenClawPluginApi): void {
  api.on("subagent_spawning", async (event) => {
    const { handleTelegramSubagentSpawning } = await loadTelegramSubagentHooksModule();
    return await handleTelegramSubagentSpawning(api, event);
  });
  api.on("subagent_ended", async (event) => {
    const { handleTelegramSubagentEnded } = await loadTelegramSubagentHooksModule();
    await handleTelegramSubagentEnded(event);
  });
  api.on("subagent_delivery_target", async (event) => {
    const { handleTelegramSubagentDeliveryTarget } = await loadTelegramSubagentHooksModule();
    return handleTelegramSubagentDeliveryTarget(event);
  });
}
