// Discord plugin module implements runtime behavior.
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { initializeDiscordProviderEndpointFromEnv } from "./provider-endpoint.js";

type DiscordChannelRuntime = {
  messageActions?: typeof import("./channel-actions.js").discordMessageActions;
  sendMessageDiscord?: typeof import("./send.js").sendMessageDiscord;
};

type DiscordRuntime = PluginRuntime & {
  channel: PluginRuntime["channel"] & {
    discord?: DiscordChannelRuntime;
  };
};

const {
  setRuntime: setDiscordRuntimeStore,
  tryGetRuntime: getOptionalDiscordRuntime,
  getRuntime: getDiscordRuntime,
} = createPluginRuntimeStore<DiscordRuntime>({
  pluginId: "discord",
  errorMessage: "Discord runtime not initialized",
});

function setDiscordRuntime(runtime: DiscordRuntime): void {
  initializeDiscordProviderEndpointFromEnv();
  setDiscordRuntimeStore(runtime);
}

export { getDiscordRuntime, getOptionalDiscordRuntime, setDiscordRuntime };
