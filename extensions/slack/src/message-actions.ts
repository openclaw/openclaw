import { createActionGate } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { extractToolSend, type ChannelToolSend } from "openclaw/plugin-sdk/tool-send";
import { listEnabledSlackAccounts, resolveSlackAccount } from "./accounts.js";

export function listSlackMessageActions(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ChannelMessageActionName[] {
  // 検索はuser tokenだけでも動くので、bot tokenの有無で除外しない検索候補リストを別に持つ
  const allEnabledAccounts = (
    accountId ? [resolveSlackAccount({ cfg, accountId })] : listEnabledSlackAccounts(cfg)
  ).filter((account) => account.enabled);
  const accounts = allEnabledAccounts.filter((account) => account.botTokenSource !== "none");
  const searchCapableAccounts = allEnabledAccounts.filter((account) => account.userToken?.trim());
  if (accounts.length === 0 && searchCapableAccounts.length === 0) {
    return [];
  }

  const isActionEnabled = (key: string, defaultValue = true) => {
    // bot tokenアカウントが無くてもuser-token-only環境のactions config gateを評価できるようにする
    const candidates = accounts.length > 0 ? accounts : searchCapableAccounts;
    for (const account of candidates) {
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
  if (accounts.length > 0) {
    actions.add("send");
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
  }

  // search.messagesはuser tokenだけ要求するので、user-token-onlyアカウントでも公開する
  if (searchCapableAccounts.length > 0 && isActionEnabled("messages")) {
    actions.add("search");
  }
  return Array.from(actions);
}

export function extractSlackToolSend(args: Record<string, unknown>): ChannelToolSend | null {
  return extractToolSend(args, "sendMessage");
}
