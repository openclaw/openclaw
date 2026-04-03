import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { discordPlugin } from "./src/channel.js";
import { setDiscordRuntime } from "./src/runtime.js";

export { discordPlugin } from "./src/channel.js";
export { setDiscordRuntime } from "./src/runtime.js";

type DiscordSubagentHooksModule = typeof import("./src/subagent-hooks.js");

let discordSubagentHooksPromise: Promise<DiscordSubagentHooksModule> | null = null;

function loadDiscordSubagentHooksModule() {
  discordSubagentHooksPromise ??= import("./src/subagent-hooks.js");
  return discordSubagentHooksPromise;
}

export default defineChannelPluginEntry({
  id: "discord",
  name: "Discord",
  description: "Discord channel plugin",
  plugin: discordPlugin,
  setRuntime: setDiscordRuntime,
  registerFull(api) {
    api.on("subagent_spawning", async (event) => {
      const { handleDiscordSubagentSpawning } = await loadDiscordSubagentHooksModule();
      return await handleDiscordSubagentSpawning(api, event);
    });
    api.on("subagent_ended", async (event) => {
      const { handleDiscordSubagentEnded } = await loadDiscordSubagentHooksModule();
      handleDiscordSubagentEnded(event);
    });
    api.on("subagent_delivery_target", async (event) => {
      const { handleDiscordSubagentDeliveryTarget } = await loadDiscordSubagentHooksModule();
      return handleDiscordSubagentDeliveryTarget(event);
    });
  },
});
