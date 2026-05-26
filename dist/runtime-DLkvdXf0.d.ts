import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as RuntimeEnv } from "./runtime-Bxifh4bY.js";
import { r as ChannelAccountSnapshot, y as ChannelMessageActionAdapter } from "./types.core-BkmTlRzr.js";
import { n as ChannelRuntimeSurface } from "./channel-runtime-surface.types-gKXwaxDV.js";
import { n as PluginRuntime } from "./types-DpjQFFwi.js";
import { u as sendMessageTelegram } from "./send-DtZGLA2D.js";
import { a as TelegramBotInfo, r as probeTelegram } from "./probe-BP11RQbF.js";
import { n as collectTelegramUnmentionedGroupIds, t as auditTelegramGroupMembership } from "./audit-DAm3l1E9.js";
import { n as resolveTelegramToken } from "./token-Cclcktlo.js";

//#region extensions/telegram/src/monitor.types.d.ts
type MonitorTelegramOpts = {
  token?: string;
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  channelRuntime?: ChannelRuntimeSurface;
  abortSignal?: AbortSignal;
  useWebhook?: boolean;
  webhookPath?: string;
  webhookPort?: number;
  webhookSecret?: string;
  webhookHost?: string;
  proxyFetch?: typeof fetch;
  webhookUrl?: string;
  webhookCertPath?: string;
  botInfo?: TelegramBotInfo;
  setStatus?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
  isolatedIngress?: {
    enabled?: boolean;
  };
};
type TelegramMonitorFn = (opts?: MonitorTelegramOpts) => Promise<void>;
//#endregion
//#region extensions/telegram/src/runtime.types.d.ts
type TelegramProbeFn = typeof probeTelegram;
type TelegramAuditCollectFn = typeof collectTelegramUnmentionedGroupIds;
type TelegramAuditMembershipFn = typeof auditTelegramGroupMembership;
type TelegramSendFn = typeof sendMessageTelegram;
type TelegramResolveTokenFn = typeof resolveTelegramToken;
type BasePluginRuntimeChannel = PluginRuntime extends {
  channel: infer T;
} ? T : never;
type TelegramChannelRuntime = {
  probeTelegram?: TelegramProbeFn;
  collectTelegramUnmentionedGroupIds?: TelegramAuditCollectFn;
  auditTelegramGroupMembership?: TelegramAuditMembershipFn;
  monitorTelegramProvider?: TelegramMonitorFn;
  sendMessageTelegram?: TelegramSendFn;
  resolveTelegramToken?: TelegramResolveTokenFn;
  messageActions?: ChannelMessageActionAdapter;
};
interface TelegramRuntimeChannel extends BasePluginRuntimeChannel {
  telegram?: TelegramChannelRuntime;
}
interface TelegramRuntime extends PluginRuntime {
  channel: TelegramRuntimeChannel;
}
//#endregion
//#region extensions/telegram/src/runtime.d.ts
declare const setTelegramRuntime: (next: TelegramRuntime) => void, clearTelegramRuntime: () => void, getTelegramRuntime: () => TelegramRuntime;
//#endregion
export { MonitorTelegramOpts as n, setTelegramRuntime as t };