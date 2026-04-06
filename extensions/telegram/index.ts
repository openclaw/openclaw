import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export { telegramPlugin } from "./src/channel.js";
export { setTelegramRuntime } from "./src/runtime.js";
export { resetTelegramThreadBindingsForTests } from "./src/thread-bindings.js";

export default defineBundledChannelEntry({
  id: "telegram",
  name: "Telegram",
  description: "Telegram channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "telegramPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setTelegramRuntime",
  },
});
