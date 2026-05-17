import {
  listQaChannelAccountIds,
  resolveDefaultQaChannelAccountId,
  resolveQaChannelAccount,
  type ResolvedQaChannelAccount,
} from "./accounts.js";
import { QA_CHANNEL_ID as CHANNEL_ID, qaChannelMeta as meta } from "./channel-meta.js";
import { qaChannelPluginConfigSchema } from "./config-schema.js";
import type { ChannelPlugin } from "./runtime-api.js";
import { applyQaSetup } from "./setup.js";
import type { CoreConfig } from "./types.js";

export const qaChannelSetupPlugin: ChannelPlugin<ResolvedQaChannelAccount> = {
  id: CHANNEL_ID,
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
  },
  reload: { configPrefixes: ["channels.qa-channel"] },
  configSchema: qaChannelPluginConfigSchema,
  setup: {
    applyAccountConfig: ({ cfg, accountId, input }) =>
      applyQaSetup({
        cfg,
        accountId,
        input: input as Record<string, unknown>,
      }),
  },
  config: {
    listAccountIds: (cfg) => listQaChannelAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolveQaChannelAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultQaChannelAccountId(cfg as CoreConfig),
    isConfigured: (account) => account.configured,
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveQaChannelAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom,
    resolveDefaultTo: ({ cfg, accountId }) =>
      resolveQaChannelAccount({ cfg: cfg as CoreConfig, accountId }).config.defaultTo,
  },
};
