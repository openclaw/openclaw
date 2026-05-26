import { l as SecretInput } from "./types.secrets-tbFW-hY6.js";
import { _ as GroupPolicy, h as DmPolicy, r as BlockStreamingCoalesceConfig } from "./types.base-DS--yneR.js";
import { an as DmConfig } from "./types.channels-C67UBRPK.js";
import { n as ChannelPlugin } from "./types.public-B2Ho5PN_.js";
//#region extensions/nextcloud-talk/src/types.d.ts
type NextcloudTalkRoomConfig = {
  requireMention?: boolean; /** Optional tool policy overrides for this room. */
  tools?: {
    allow?: string[];
    deny?: string[];
  }; /** If specified, only load these skills for this room. Omit = all skills; empty = no skills. */
  skills?: string[]; /** If false, disable the bot for this room. */
  enabled?: boolean; /** Optional allowlist for room senders (user ids). */
  allowFrom?: string[]; /** Optional system prompt snippet for this room. */
  systemPrompt?: string;
};
type NextcloudTalkNetworkConfig = {
  /** Dangerous opt-in for self-hosted Nextcloud Talk on trusted private/internal hosts. */dangerouslyAllowPrivateNetwork?: boolean;
};
type NextcloudTalkAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */name?: string; /** If false, do not start this Nextcloud Talk account. Default: true. */
  enabled?: boolean; /** Base URL of the Nextcloud instance (e.g., "https://cloud.example.com"). */
  baseUrl?: string; /** Bot shared secret from occ talk:bot:install output. */
  botSecret?: SecretInput; /** Path to file containing bot secret (for secret managers). */
  botSecretFile?: string; /** Optional API user for room lookups (DM detection). */
  apiUser?: string; /** Optional API password/app password for room lookups. */
  apiPassword?: SecretInput; /** Path to file containing API password/app password. */
  apiPasswordFile?: string; /** Direct message policy (default: pairing). */
  dmPolicy?: DmPolicy; /** Webhook server port. Default: 8788. */
  webhookPort?: number; /** Webhook server host. Default: "0.0.0.0". */
  webhookHost?: string; /** Webhook endpoint path. Default: "/nextcloud-talk-webhook". */
  webhookPath?: string; /** Public URL for the webhook (used if behind reverse proxy). */
  webhookPublicUrl?: string; /** Optional allowlist of user IDs allowed to DM the bot. */
  allowFrom?: string[]; /** Optional allowlist for Nextcloud Talk room senders (user ids). */
  groupAllowFrom?: string[]; /** Group message policy (default: allowlist). */
  groupPolicy?: GroupPolicy; /** Per-room configuration (key is room token). */
  rooms?: Record<string, NextcloudTalkRoomConfig>; /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number; /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number; /** Per-DM config overrides keyed by user ID. */
  dms?: Record<string, DmConfig>; /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number; /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline"; /** Disable block streaming for this account. */
  blockStreaming?: boolean; /** Merge streamed block replies before sending. */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig; /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string; /** Media upload max size in MB. */
  mediaMaxMb?: number; /** Network policy overrides for self-hosted Nextcloud Talk on trusted private/internal hosts. */
  network?: NextcloudTalkNetworkConfig;
};
//#endregion
//#region extensions/nextcloud-talk/src/accounts.d.ts
type ResolvedNextcloudTalkAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl: string;
  secret: string;
  secretSource: "env" | "secretFile" | "config" | "none";
  config: NextcloudTalkAccountConfig;
};
//#endregion
//#region extensions/nextcloud-talk/src/channel.d.ts
declare const nextcloudTalkPlugin: ChannelPlugin<ResolvedNextcloudTalkAccount>;
//#endregion
export { nextcloudTalkPlugin as t };