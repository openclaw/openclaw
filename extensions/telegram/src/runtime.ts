import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

type TelegramChannelRuntime = {
  probeTelegram?: typeof import("./probe.js").probeTelegram;
  collectTelegramUnmentionedGroupIds?: typeof import("./audit.js").collectTelegramUnmentionedGroupIds;
  auditTelegramGroupMembership?: typeof import("./audit.js").auditTelegramGroupMembership;
  monitorTelegramProvider?: typeof import("./monitor.js").monitorTelegramProvider;
  sendMessageTelegram?: typeof import("./send.js").sendMessageTelegram;
  resolveTelegramToken?: typeof import("./token.js").resolveTelegramToken;
  messageActions?: typeof import("./channel-actions.js").telegramMessageActions;
};

export type TelegramRuntime = PluginRuntime & {
  channel: PluginRuntime["channel"] & {
    telegram?: TelegramChannelRuntime;
  };
};

const {
  setRuntime: setTelegramRuntime,
  clearRuntime: clearTelegramRuntime,
  getRuntime: getTelegramRuntime,
} = createPluginRuntimeStore<TelegramRuntime>("Telegram runtime not initialized");
export { clearTelegramRuntime, getTelegramRuntime, setTelegramRuntime };
