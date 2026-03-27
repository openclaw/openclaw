import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { telegramPlugin } from "./src/channel.js";
import { setTelegramRuntime } from "./src/runtime.js";

export { telegramPlugin } from "./src/channel.js";
export { setTelegramRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "telegram",
  name: "Telegram",
  description: "Telegram channel plugin",
  plugin: telegramPlugin as ChannelPlugin,
  setRuntime: setTelegramRuntime,
});
