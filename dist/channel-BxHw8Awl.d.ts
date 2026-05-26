import { l as SecretInput } from "./types.secrets-tbFW-hY6.js";
import { t as BaseProbeResult } from "./types.core-BkmTlRzr.js";
import { n as ChannelPlugin } from "./types.public-B2Ho5PN_.js";
//#region extensions/zalo/src/types.d.ts
type ZaloAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */name?: string; /** If false, do not start this Zalo account. Default: true. */
  enabled?: boolean; /** Bot token from Zalo Bot Creator. */
  botToken?: SecretInput; /** Path to file containing the bot token. */
  tokenFile?: string; /** Webhook URL for receiving updates (HTTPS required). */
  webhookUrl?: string; /** Webhook secret token (8-256 chars) for request verification. */
  webhookSecret?: SecretInput; /** Webhook path for the gateway HTTP server (defaults to webhook URL path). */
  webhookPath?: string; /** Direct message access policy (default: pairing). */
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled"; /** Allowlist for DM senders (Zalo user IDs). */
  allowFrom?: Array<string | number>; /** Group-message access policy. */
  groupPolicy?: "open" | "allowlist" | "disabled"; /** Allowlist for group senders (falls back to allowFrom when unset). */
  groupAllowFrom?: Array<string | number>; /** Max inbound media size in MB. */
  mediaMaxMb?: number; /** Proxy URL for API requests. */
  proxy?: string; /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
};
type ZaloTokenSource = "env" | "config" | "configFile" | "none";
type ResolvedZaloAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  token: string;
  tokenSource: ZaloTokenSource;
  config: ZaloAccountConfig;
};
//#endregion
//#region extensions/zalo/src/api.d.ts
type ZaloBotInfo = {
  id: string;
  name: string;
  avatar?: string;
};
//#endregion
//#region extensions/zalo/src/probe.d.ts
type ZaloProbeResult = BaseProbeResult<string> & {
  bot?: ZaloBotInfo;
  elapsedMs: number;
};
//#endregion
//#region extensions/zalo/src/channel.d.ts
declare const zaloPlugin: ChannelPlugin<ResolvedZaloAccount, ZaloProbeResult>;
//#endregion
export { zaloPlugin as t };