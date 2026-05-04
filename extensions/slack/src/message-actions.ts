import { createActionGate } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { extractToolSend, type ChannelToolSend } from "openclaw/plugin-sdk/tool-send";
import { listEnabledSlackAccounts, resolveSlackAccount } from "./accounts.js";

export function listSlackMessageActions(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ChannelMessageActionName[] {
  const accounts = (
    accountId ? [resolveSlackAccount({ cfg, accountId })] : listEnabledSlackAccounts(cfg)
  ).filter((account) => account.enabled);
  const botAccounts = accounts.filter((account) => account.botTokenSource !== "none");
  const searchAccounts = accounts.filter((account) => account.userToken?.trim());
  if (botAccounts.length === 0 && searchAccounts.length === 0) {
    return [];
  }

  const isActionEnabled = (key: string, defaultValue = true, scopedAccounts = botAccounts) => {
    for (const account of scopedAccounts) {
      const gate = createActionGate(
        (account.actions ?? cfg.channels?.slack?.actions) as Record<string, boolean | undefined>,
      );
      if (gate(key, defaultValue)) {
        return true;
      }
    }
    return false;
  };

  const actions = new Set<ChannelMessageActionName>();
  if (botAccounts.length > 0) {
    actions.add("send");
  }
  if (isActionEnabled("reactions")) {
    actions.add("react");
    actions.add("reactions");
  }
  if (isActionEnabled("messages")) {
    actions.add("read");
    actions.add("edit");
    actions.add("delete");
    actions.add("download-file");
    actions.add("upload-file");
  }
  if (isActionEnabled("messages", true, searchAccounts)) {
    actions.add("search");
  }
  if (isActionEnabled("pins")) {
    actions.add("pin");
    actions.add("unpin");
    actions.add("list-pins");
  }
  if (isActionEnabled("memberInfo")) {
    actions.add("member-info");
  }
  if (isActionEnabled("emojiList")) {
    actions.add("emoji-list");
  }
  return Array.from(actions);
}

export function extractSlackToolSend(args: Record<string, unknown>): ChannelToolSend | null {
  return extractToolSend(args, "sendMessage");
}
