import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { telegramPlugin } from "./src/channel.js";
import { createProxyIngressHandler } from "./src/proxy-ingress.js";
import { setTelegramRuntime } from "./src/runtime.js";

export { telegramPlugin } from "./src/channel.js";
export { setTelegramRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: "telegram",
  name: "Telegram",
  description: "Telegram channel plugin",
  plugin: telegramPlugin as ChannelPlugin,
  setRuntime: setTelegramRuntime,
  registerFull(api) {
    const handler = createProxyIngressHandler(api);
    api.registerHttpRoute({
      path: "/api/channels/telegram/proxy-ingress",
      auth: "gateway",
      match: "exact",
      handler,
    });
  },
});
