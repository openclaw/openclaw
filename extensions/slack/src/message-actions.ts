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
  ).filter((account) => account.enabled && account.botTokenSource !== "none");
  if (accounts.length === 0) {
    return [];
  }

  const isActionEnabled = (key: string, defaultValue = true) =>
    accounts.some((account) => isAccountActionEnabled(account, key, defaultValue));

  const isActionEnabledWithUserToken = (key: string, defaultValue = true) => {
    for (const account of accounts) {
      if (
        account.userTokenSource !== "none" &&
        isAccountActionEnabled(account, key, defaultValue)
      ) {
        return true;
      }
    }
    return false;
  };

  const actions = new Set<ChannelMessageActionName>(["send"]);
  if (isActionEnabled("reactions")) {
    actions.add("react");
    actions.add("reactions");
  }
  if (isActionEnabled("messages")) {
    actions.add("read");
    actions.add("edit");
    actions.add("delete");
    actions.add("get-permalink");
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
  if (isActionEnabledWithUserToken("search", false)) {
    actions.add("search");
  }
  if (isActionEnabled("channelInfo", false)) {
    actions.add("channel-info");
  }
  if (isActionEnabled("channels", false)) {
    actions.add("channel-list");
  }
  if (isActionEnabled("emojiList")) {
    actions.add("emoji-list");
  }
  if (isActionEnabled("files", false)) {
    actions.add("file-list");
    actions.add("file-delete");
  }
  if (isActionEnabled("scheduledMessages", false)) {
    actions.add("schedule-message");
    actions.add("scheduled-list");
    actions.add("delete-scheduled");
  }
  if (isActionEnabled("ephemeralMessages", false)) {
    actions.add("post-ephemeral");
  }
  if (isActionEnabled("bookmarks", false)) {
    actions.add("bookmark-add");
    actions.add("bookmark-edit");
    actions.add("bookmark-list");
    actions.add("bookmark-remove");
  }
  if (isActionEnabled("reminders", false)) {
    actions.add("reminder-add");
    actions.add("reminder-list");
    actions.add("reminder-info");
    actions.add("reminder-complete");
    actions.add("reminder-delete");
  }
  if (isActionEnabled("canvases", false)) {
    actions.add("canvas-create");
    actions.add("canvas-edit");
    actions.add("canvas-delete");
    actions.add("canvas-section-lookup");
    actions.add("channel-canvas-create");
  }
  return Array.from(actions);
}

export function extractSlackToolSend(args: Record<string, unknown>): ChannelToolSend | null {
  return extractToolSend(args, "sendMessage");
}

function isAccountActionEnabled(
  account: ReturnType<typeof resolveSlackAccount>,
  key: string,
  defaultValue: boolean,
) {
  const gate = createActionGate((account.actions ?? {}) as Record<string, boolean | undefined>);
  return gate(key, defaultValue);
}
