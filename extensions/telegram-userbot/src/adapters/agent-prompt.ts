/**
 * Agent prompt adapter for the telegram-userbot channel.
 *
 * Provides message tool hints that describe userbot-specific capabilities
 * to the AI agent, with dynamic reporting based on the configured
 * capabilities in `channels.telegram-userbot.capabilities`.
 */

import type { ChannelAgentPromptAdapter, OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveTelegramUserbotAccount } from "./config.js";

/**
 * Resolve the effective capabilities for an account, falling back to
 * defaults when the capabilities block is omitted.
 */
function resolveCapabilities(cfg: OpenClawConfig, accountId?: string | null) {
  const account = resolveTelegramUserbotAccount({ cfg, accountId });
  return {
    deleteOtherMessages: account.config.capabilities?.deleteOtherMessages ?? true,
    readHistory: account.config.capabilities?.readHistory ?? true,
    forceDocument: account.config.capabilities?.forceDocument ?? true,
  };
}

export const telegramUserbotAgentPromptAdapter: ChannelAgentPromptAdapter = {
  messageToolHints: ({ cfg, accountId }) => {
    const caps = resolveCapabilities(cfg, accountId);

    const hints: string[] = [
      "",
      "### Telegram Userbot Channel",
      "This channel uses a real Telegram user account (MTProto), not a bot.",
      "Messages appear as sent by the user, not a bot account.",
      "",
      "Capabilities:",
      "- Can forward messages between chats",
      "- Can pin and unpin messages in conversations",
      "- Can react to messages with any emoji",
      "- Can edit and unsend own messages",
    ];

    if (caps.deleteOtherMessages) {
      hints.push("- Can delete other people's messages in DMs");
    }

    if (caps.readHistory) {
      hints.push("- Can read and mark full chat history as read");
    }

    hints.push("", "Targeting: use numeric Telegram user/chat ID or @username as the target.");

    return hints;
  },
};
