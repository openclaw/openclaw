import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "openclaw/plugin-sdk";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { addReactionFeishu, listReactionsFeishu, removeReactionFeishu } from "./reactions.js";

export const feishuMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledFeishuAccounts(cfg);
    if (accounts.length === 0) {
      return [];
    }
    const actions: ChannelMessageActionName[] = ["react", "reactions"];
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

      const remove = typeof params.remove === "boolean" ? params.remove : false;

      if (remove) {
        const reactionId = readStringParam(params, "reactionId");
        if (!reactionId) {
          throw new Error(
            'reactionId is required to remove a reaction. Use message(action="reactions") to list reaction IDs first.',
          );
        }
        await removeReactionFeishu({
          cfg,
          messageId,
          reactionId,
          accountId: resolvedAccountId,
        });
        return jsonResult({ ok: true, action: "react", removed: true, messageId, reactionId });
      }

      const rawEmoji =
        readStringParam(params, "emoji") ??
        readStringParam(params, "emojiName") ??
        readStringParam(params, "emojiType");

      const emojiType = normalizeFeishuEmoji(rawEmoji);

      const result = await addReactionFeishu({
        cfg,
        messageId,
        emojiType,
        accountId: resolvedAccountId,
      });

      return jsonResult({ ok: true, action: "react", messageId, emojiType, ...result });
    }

    if (action === "reactions") {
      const messageId =
        readStringParam(params, "messageId") ??
        readStringParam(params, "message_id") ??
        (ctx.toolContext?.currentMessageId != null
          ? String(ctx.toolContext.currentMessageId)
          : undefined);

      if (!messageId) {
        throw new Error("messageId is required to list reactions.");
      }

      const emojiType = readStringParam(params, "emojiType");
      const reactions = await listReactionsFeishu({
        cfg,
        messageId,
        emojiType,
        accountId: resolvedAccountId,
      });

      return jsonResult({ ok: true, action: "reactions", messageId, reactions });
    }

    throw new Error(`Unsupported feishu action: ${action}`);
  },
};

/**
 * Normalize common emoji names to Feishu emoji types.
 * Feishu uses UPPER_CASE emoji type names like "THUMBSUP", "HEART", "SMILE".
 * This helper accepts common aliases and maps them to Feishu's format.
 *
 * If no emoji is provided, defaults to THUMBSUP.
 * If the input normalizes to an empty string (e.g., unsupported unicode emoji),
 * throws an error instead of silently defaulting.
 *
 * @see https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
 */
function normalizeFeishuEmoji(input: string | undefined): string {
  if (!input) {
    return "THUMBSUP";
  }

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

  if (!upper) {
    throw new Error(
      `Unrecognized emoji: "${input}". Use Feishu emoji type names like THUMBSUP, HEART, SMILE, FIRE, etc.`,
    );
  }

  return upper;
}
