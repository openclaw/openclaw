import { normalizeChatType } from "openclaw/plugin-sdk/account-core";
import type { SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";

export function resolveSlackReplyToMode(
  account: Pick<SlackAccountConfig, "replyToMode" | "replyToModeByChatType">,
  chatType?: string | null,
): NonNullable<SlackAccountConfig["replyToMode"]> {
  const normalized = normalizeChatType(chatType ?? undefined);
  if (normalized && account.replyToModeByChatType?.[normalized] !== undefined) {
    return account.replyToModeByChatType[normalized] ?? "off";
  }
  return account.replyToMode ?? "off";
}
