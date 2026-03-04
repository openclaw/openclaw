import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "../../../src/channels/plugins/types.js";
import { readStringParam } from "../../../src/agents/tools/common.js";
import { resolveFeishuAccount, listFeishuAccountIds } from "./accounts.js";
import { addReactionFeishu, listReactionsFeishu, removeReactionFeishu, FeishuEmoji } from "./reactions.js";
import { sendMessageFeishu } from "./send.js";

/**
 * Feishu channel message action adapter.
 *
 * Wires up the existing reactions.ts functions (addReactionFeishu, listReactionsFeishu,
 * removeReactionFeishu) to the message tool's `react` and `reactions` actions.
 *
 * Resolves: https://github.com/openclaw/openclaw/issues/33948
 */
export const feishuMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }: { cfg: ClawdbotConfig }): ChannelMessageActionName[] => {
    // Check if any feishu account is configured
    const accountIds = listFeishuAccountIds(cfg);
    const hasConfigured = accountIds.some((id) => {
      const account = resolveFeishuAccount({ cfg, accountId: id });
      return account.configured && account.enabled;
    });

    if (!hasConfigured) return [];

    const actions: ChannelMessageActionName[] = ["send", "react", "reactions"];
    return actions;
  },

  handleAction: async (ctx) => {
    const { action, params, cfg } = ctx;
    const accountId = ctx.accountId ?? undefined;

    if (action === "send") {
      const to = readStringParam(params, "to", { required: true });
      const message = readStringParam(params, "message", { required: true, allowEmpty: true });
      const result = await sendMessageFeishu({ cfg, to, text: message, accountId });
      return {
        channel: "feishu",
        messageId: result?.message_id || "unknown",
        chatId: to,
      };
    }

    if (action === "react") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const emoji = readStringParam(params, "emoji", { allowEmpty: true }) ?? "THUMBSUP";
      const remove = typeof params.remove === "boolean" ? params.remove : false;

      // Normalize emoji: support both uppercase Feishu names ("THUMBSUP") and
      // common lowercase/coloned forms (":thumbsup:", "thumbsup")
      const normalizedEmoji = normalizeFeishuEmoji(emoji);

      if (remove) {
        // To remove, we need to find the reaction ID first
        const reactions = await listReactionsFeishu({
          cfg,
          messageId,
          emojiType: normalizedEmoji,
          accountId,
        });
        // Find the bot's own reaction
        const botReaction = reactions.find((r) => r.operatorType === "app");
        if (botReaction) {
          await removeReactionFeishu({
            cfg,
            messageId,
            reactionId: botReaction.reactionId,
            accountId,
          });
          return { success: true, action: "remove", emoji: normalizedEmoji };
        }
        return { success: false, reason: "No matching bot reaction found to remove" };
      }

      const result = await addReactionFeishu({
        cfg,
        messageId,
        emojiType: normalizedEmoji,
        accountId,
      });
      return { success: true, action: "add", emoji: normalizedEmoji, reactionId: result.reactionId };
    }

    if (action === "reactions") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const emojiFilter = readStringParam(params, "emoji", { allowEmpty: true });
      const normalizedFilter = emojiFilter ? normalizeFeishuEmoji(emojiFilter) : undefined;

      const reactions = await listReactionsFeishu({
        cfg,
        messageId,
        emojiType: normalizedFilter,
        accountId,
      });

      return {
        reactions: reactions.map((r) => ({
          reactionId: r.reactionId,
          emoji: r.emojiType,
          operatorType: r.operatorType,
          operatorId: r.operatorId,
        })),
        total: reactions.length,
      };
    }

    return null;
  },
};

/**
 * Normalize emoji input to Feishu emoji type.
 *
 * Accepts:
 * - Feishu emoji type directly: "THUMBSUP", "HEART"
 * - Lowercase: "thumbsup", "heart"
 * - Coloned (Slack-style): ":thumbsup:", ":heart:"
 * - Common aliases: "👍" → "THUMBSUP", "❤️" → "HEART", "🔥" → "FIRE"
 */
function normalizeFeishuEmoji(input: string): string {
  // Strip colons (Slack-style :emoji:)
  let cleaned = input.replace(/^:|:$/g, "").trim();

  // Check Unicode emoji aliases
  const unicodeMap: Record<string, string> = {
    "👍": "THUMBSUP",
    "👎": "THUMBSDOWN",
    "❤️": "HEART",
    "❤": "HEART",
    "😀": "GRINNING",
    "😊": "SMILE",
    "😂": "LAUGHING",
    "😢": "CRY",
    "😡": "ANGRY",
    "😮": "SURPRISED",
    "🤔": "THINKING",
    "👏": "CLAP",
    "👌": "OK",
    "✊": "FIST",
    "🙏": "PRAY",
    "🔥": "FIRE",
    "🎉": "PARTY",
    "✅": "CHECK",
    "❌": "CROSS",
    "❓": "QUESTION",
    "❗": "EXCLAMATION",
  };

  if (unicodeMap[cleaned]) {
    return unicodeMap[cleaned];
  }

  // Convert to uppercase and check against known Feishu emoji types
  const upper = cleaned.toUpperCase();
  if (upper in FeishuEmoji) {
    return upper;
  }

  // If it's already a valid Feishu emoji type (case-insensitive match), return uppercase
  // Otherwise return as-is (Feishu will reject invalid types with an error)
  return upper || "THUMBSUP";
}