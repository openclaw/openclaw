import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type { TelegramMonitorFn } from "./monitor.types.js";

export interface TelegramRuntime extends PluginRuntime {
  channel: PluginRuntime["channel"] & {
    telegram?: {
      probeTelegram?: typeof import("./probe.js").probeTelegram;
      collectTelegramUnmentionedGroupIds?: typeof import("./audit.js").collectTelegramUnmentionedGroupIds;
      auditTelegramGroupMembership?: typeof import("./audit.js").auditTelegramGroupMembership;
      monitorTelegramProvider?: TelegramMonitorFn;
      sendMessageTelegram?: typeof import("./send.js").sendMessageTelegram;
      resolveTelegramToken?: typeof import("./token.js").resolveTelegramToken;
    };
  };
}
