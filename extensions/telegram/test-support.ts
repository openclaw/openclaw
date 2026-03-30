import { buildDmGroupAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import { createApproverRestrictedNativeApprovalAdapter } from "openclaw/plugin-sdk/approval-runtime";
import { getChatChannelMeta, type ChannelPlugin } from "openclaw/plugin-sdk/telegram-core";
import type { ResolvedTelegramAccount } from "./src/accounts.js";
import { resolveTelegramAccount } from "./src/accounts.js";
import { listTelegramAccountIds } from "./src/accounts.js";
import {
  getTelegramExecApprovalApprovers,
  isTelegramExecApprovalAuthorizedSender,
  isTelegramExecApprovalApprover,
  isTelegramExecApprovalClientEnabled,
  resolveTelegramExecApprovalTarget,
} from "./src/exec-approvals.js";
import { telegramConfigAdapter } from "./src/shared.js";

const telegramNativeApprovalAdapter = createApproverRestrictedNativeApprovalAdapter({
  channel: "telegram",
  channelLabel: "Telegram",
  listAccountIds: listTelegramAccountIds,
  hasApprovers: ({ cfg, accountId }) =>
    getTelegramExecApprovalApprovers({ cfg, accountId }).length > 0,
  isExecAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isTelegramExecApprovalAuthorizedSender({ cfg, accountId, senderId }),
  isPluginAuthorizedSender: ({ cfg, accountId, senderId }) =>
    isTelegramExecApprovalApprover({ cfg, accountId, senderId }),
  isNativeDeliveryEnabled: ({ cfg, accountId }) =>
    isTelegramExecApprovalClientEnabled({ cfg, accountId }),
  resolveNativeDeliveryMode: ({ cfg, accountId }) =>
    resolveTelegramExecApprovalTarget({ cfg, accountId }),
  requireMatchingTurnSourceChannel: true,
});

export const telegramCommandTestPlugin = {
  id: "telegram",
  meta: getChatChannelMeta("telegram"),
  capabilities: {
    chatTypes: ["direct", "group", "channel", "thread"],
    reactions: true,
    threads: true,
    media: true,
    polls: true,
    nativeCommands: true,
    blockStreaming: true,
  },
  config: telegramConfigAdapter,
  auth: telegramNativeApprovalAdapter.auth,
  pairing: {},
  allowlist: buildDmGroupAccountAllowlistAdapter<ResolvedTelegramAccount>({
    channelId: "telegram",
    resolveAccount: resolveTelegramAccount,
    normalize: ({ cfg, accountId, values }) =>
      telegramConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
    resolveDmAllowFrom: (account) => account.config.allowFrom,
    resolveGroupAllowFrom: (account) => account.config.groupAllowFrom,
    resolveDmPolicy: (account) => account.config.dmPolicy,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
  }),
} satisfies Pick<
  ChannelPlugin<ResolvedTelegramAccount>,
  "id" | "meta" | "capabilities" | "config" | "auth" | "pairing" | "allowlist"
>;
