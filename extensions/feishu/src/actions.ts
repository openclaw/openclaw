import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { addReactionFeishu } from "./reactions.js";

function readStringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value).trim() || undefined;
}

export const feishuMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledFeishuAccounts(cfg);
    if (accounts.length === 0) {
      return [];
    }
    const actions: ChannelMessageActionName[] = ["react"];
    return actions;
  },

  handleAction: async (ctx) => {
    const { action, cfg, params, accountId } = ctx;

    const resolvedAccountId = accountId ?? undefined;

    if (action === "react") {
      const messageId =
        readStringParam(params, "messageId") ??
        readStringParam(params, "message_id") ??
        (ctx.toolContext?.currentMessageId != null
          ? String(ctx.toolContext.currentMessageId)
          : undefined);

      if (!messageId) {
        throw new Error(
          "messageId is required. Provide messageId explicitly or react to the current inbound message.",
        );
      }

      const emoji =
        readStringParam(params, "emoji") ??
        readStringParam(params, "emojiName") ??
        readStringParam(params, "emojiType");

      const emojiType = normalizeFeishuEmoji(emoji ?? "THUMBSUP");

      const result = await addReactionFeishu({
        cfg,
        messageId,
        emojiType,
        accountId: resolvedAccountId,
      });

      return {
        ok: true as const,
        data: { action: "react", messageId, emojiType, ...result },
      };
    }

    throw new Error(`Unsupported feishu action: ${action}`);
  },
};

/**
 * Normalize common emoji names to Feishu emoji types.
 * Feishu uses UPPER_CASE emoji type names like "THUMBSUP", "HEART", "SMILE".
 * This helper accepts common aliases and maps them to Feishu's format.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
 */
function normalizeFeishuEmoji(input: string): string {
  const upper = input.toUpperCase().replace(/[^A-Z0-9_]/g, "");

  const aliases: Record<string, string> = {
    LIKE: "THUMBSUP",
    THUMBS_UP: "THUMBSUP",
    THUMBS_DOWN: "THUMBSDOWN",
    LOVE: "HEART",
    LAUGH: "LAUGHING",
    CLAPPING: "CLAP",
    CELEBRATE: "PARTY",
    YES: "CHECK",
    NO: "CROSS",
  };

  if (aliases[upper]) {
    return aliases[upper];
  }

  // If already a valid Feishu emoji type, return as-is
  return upper || "THUMBSUP";
}
