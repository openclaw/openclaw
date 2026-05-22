import { i as OpenClawConfig } from "./types.openclaw-BMMD0Ykw.js";
import { n as RuntimeEnv } from "./runtime-Dnacw8wE.js";
import { r as ChannelAccountSnapshot, y as ChannelMessageActionAdapter } from "./types.core-CgjRAtD6.js";
import { n as ChannelRuntimeSurface } from "./channel-runtime-surface.types-D7y5EBFg.js";
import { n as PluginRuntime } from "./types-1xy7Ddy0.js";
import { u as sendMessageTelegram } from "./send-DF3YbazO.js";
import { a as TelegramBotInfo, r as probeTelegram } from "./probe-BmnIJ_yS.js";
import { n as collectTelegramUnmentionedGroupIds, t as auditTelegramGroupMembership } from "./audit-CfuzoVIS.js";
import { n as resolveTelegramToken } from "./token-BHnx2GRF.js";

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