import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "../../../src/channels/plugins/types.js";
import { readStringParam } from "../../../src/agents/tools/common.js";
import { resolveFeishuAccount, listFeishuAccountIds } from "./accounts.js";
import { addReactionFeishu, listReactionsFeishu, removeReactionFeishu, FeishuEmoji } from "./reactions.js";

/**
 * Feishu channel message action adapter.
 *
 * Wires up the existing reactions.ts functions (addReactionFeishu, listReactionsFeishu,
 * removeReactionFeishu) to the message tool's `react` and `reactions` actions.
 *
 * Note: The `send` action is intentionally NOT handled here — it is already handled
 * by the core outbound adapter (feishuOutbound in outbound.ts), which supports media,
 * reply-to, streaming cards, and other features. Duplicating send here would lose those
 * capabilities.
 *
 * Resolves: https://github.com/openclaw/openclaw/issues/33948
 */
export const feishuMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }: { cfg: ClawdbotConfig }): ChannelMessageActionName[] => {
    // Check if any feishu account is configured and enabled
    const accountIds = listFeishuAccountIds(cfg);
    const hasConfigured = accountIds.some((id) => {
      const account = resolveFeishuAccount({ cfg, accountId: id });
      return account.configured && account.enabled;
    });

    if (!hasConfigured) return [];

    // Only expose reaction actions; send is handled by core outbound adapter
    return ["react", "reactions"];
  },

  handleAction: async (ctx) => {
    const { action, params, cfg } = ctx;
    const accountId = ctx.accountId ?? undefined;

    if (action === "react") {
      const messageId = readStringParam(params, "messageId", { required: true });
      const emoji = readStringParam(params, "emoji", { allowEmpty: true }) ?? "THUMBSUP";
      const remove = typeof params.remove === "boolean" ? params.remove : false;

      // Normalize emoji: support both uppercase Feishu names ("THUMBSUP") and
      // common lowercase/coloned forms (":thumbsup:", "thumbsup") and Unicode
      const normalizedEmoji = normalizeFeishuEmoji(emoji);

      if (remove) {
        // To remove, we need to find the reaction ID first.
        // We scope the search to the current bot's appId to avoid removing
        // another bot's reaction in multi-bot environments.
        const reactions = await listReactionsFeishu({
          cfg,
          messageId,
          emojiType: normalizedEmoji,
          accountId,
        });

        // Resolve the current bot's app open_id for identity matching.
        // Feishu reaction operatorId is the bot's open_id when operatorType is "app".
        const account = resolveFeishuAccount({ cfg, accountId });
        const botAppId = account.appId;

        // Find the current bot's own reaction by checking both operatorType and operatorId.
        // If we can't determine our own appId, fall back to first app reaction (best effort).
        const botReaction = reactions.find((r) => {
          if (r.operatorType !== "app") return false;
          // If we know our appId, verify it matches; otherwise accept any app reaction
          if (botAppId && r.operatorId) {
            return r.operatorId === botAppId;
          }
          return true;
        });

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

    // Unknown action — return null to let the framework handle it
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
 *
 * Exported for testability.
 */
export function normalizeFeishuEmoji(input: string): string {
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

  // Return uppercase — Feishu will reject invalid types with an error
  return upper || "THUMBSUP";
}