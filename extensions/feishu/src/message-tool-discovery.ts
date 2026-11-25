import { createActionGate } from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-contract";
import {
  inspectFeishuCredentials,
  listEnabledFeishuAccounts,
  resolveFeishuAccount,
} from "./accounts.js";
import { resolveFeishuStickerSet } from "./sticker-catalog.js";
import type { ResolvedFeishuAccount } from "./types.js";

export function isFeishuActionEnabled(
  account: ResolvedFeishuAccount,
  action: "reactions" | "sticker",
): boolean {
  if (!account.enabled || !account.configured) {
    return false;
  }
  return createActionGate(account.config.actions)(action, action === "reactions");
}

export function describeFeishuMessageTool({
  cfg,
  accountId,
}: Parameters<
  NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>
>[0]): ChannelMessageToolDiscovery {
  const enabledAccounts = accountId
    ? [resolveFeishuAccount({ cfg, accountId })].filter(
        (account) => account.enabled && account.configured,
      )
    : listEnabledFeishuAccounts(cfg);
  const enabled =
    enabledAccounts.length > 0 ||
    (!accountId &&
      cfg.channels?.feishu?.enabled !== false &&
      Boolean(inspectFeishuCredentials(cfg.channels?.feishu, cfg)));
  if (enabledAccounts.length === 0) {
    return {
      actions: [],
      capabilities: enabled ? ["presentation"] : [],
    };
  }
  const actions = new Set<ChannelMessageActionName>([
    "send",
    "read",
    "edit",
    "thread-reply",
    "pin",
    "list-pins",
    "unpin",
    "member-info",
    "channel-info",
    "channel-list",
  ]);
  if (enabledAccounts.some((account) => isFeishuActionEnabled(account, "reactions"))) {
    actions.add("react");
    actions.add("reactions");
  }
  if (enabledAccounts.some((account) => isFeishuActionEnabled(account, "sticker"))) {
    actions.add("sticker");
  }
  const selectedAccount = resolveFeishuAccount({ cfg, accountId });
  if (
    isFeishuActionEnabled(selectedAccount, "sticker") &&
    resolveFeishuStickerSet(cfg, selectedAccount).length > 0
  ) {
    actions.add("sticker-search");
  }
  return {
    actions: Array.from(actions),
    capabilities: enabled ? ["presentation"] : [],
    // Feishu member id aliases; all-configured keeps them for bound or scheduled turns.
    schema: {
      actions: ["member-info", "channel-info"],
      visibility: "all-configured",
      properties: {
        memberIdType: { type: "string" },
        openId: { type: "string" },
        unionId: { type: "string" },
      },
    },
  };
}
