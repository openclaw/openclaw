import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { registerTelegramDirectSessionHooks } from "./direct-session-routing-api.js";
import { telegramPluginConfigSchema } from "./src/direct-session-routing-config.js";

export default defineBundledChannelEntry({
  id: "telegram",
  name: "Telegram",
  description: "Telegram channel plugin",
  importMetaUrl: import.meta.url,
  configSchema: telegramPluginConfigSchema,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "telegramPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setTelegramRuntime",
  },
  registerFull(api) {
    registerTelegramDirectSessionHooks(api);
  },
});
