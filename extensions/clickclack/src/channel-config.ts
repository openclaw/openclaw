import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import {
  DEFAULT_ACCOUNT_ID,
  listClickClackAccountIds,
  resolveClickClackAccount,
  resolveDefaultClickClackAccountId,
} from "./accounts.js";
import type { CoreConfig, ResolvedClickClackAccount } from "./types.js";

export const CLICKCLACK_CHANNEL_ID = "clickclack" as const;
export const clickClackMeta = { ...getChatChannelMeta(CLICKCLACK_CHANNEL_ID) };

export const clickClackReload = {
  configPrefixes: ["channels.clickclack"],
  // Sender admission reads current config. Replacing the monitor would defer
  // revocation until an ask_user turn waiting for that sender ends.
  noopPrefixes: ["channels.clickclack.allowFrom", "channels.clickclack.accounts.*.allowFrom"],
} satisfies ChannelPlugin<ResolvedClickClackAccount>["reload"];

export const clickClackConfigAdapter = {
  listAccountIds: (cfg) => listClickClackAccountIds(cfg as CoreConfig),
  resolveAccount: (cfg, accountId) =>
    resolveClickClackAccount({ cfg: cfg as CoreConfig, accountId }),
  defaultAccountId: (cfg) => resolveDefaultClickClackAccountId(cfg as CoreConfig),
  isConfigured: (account) => account.configured,
  resolveAllowFrom: ({ cfg, accountId }) =>
    resolveClickClackAccount({ cfg: cfg as CoreConfig, accountId }).allowFrom,
  resolveDefaultTo: ({ cfg, accountId }) =>
    resolveClickClackAccount({ cfg: cfg as CoreConfig, accountId }).defaultTo,
} satisfies ChannelPlugin<ResolvedClickClackAccount>["config"];

export { DEFAULT_ACCOUNT_ID };
