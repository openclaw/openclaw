import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { addReactionFeishu, listReactionsFeishu, removeReactionFeishu } from "./reactions.js";

/** Read a string parameter by key, returning undefined when absent or empty. */
function readStr(params: Record<string, unknown>, key: string): string | undefined {
  const raw = params[key];
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed || undefined;
}

/** Wrap a payload into the AgentToolResult shape expected by the action adapter. */
function toJsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export const feishuMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledFeishuAccounts(cfg);
    if (accounts.length === 0) {
      return [];
    }
    return ["react", "reactions"];
  },

  supportsAction: ({ action }) => action === "react" || action === "reactions",

  handleAction: async (ctx) => {
    const { action, cfg, params, accountId } = ctx;

    const resolvedAccountId = accountId ?? undefined;

    if (action === "react") {
      const messageId =
        readStr(params, "messageId") ??
        readStr(params, "message_id") ??
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
        const reactionId = readStr(params, "reactionId");
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
        return toJsonResult({ ok: true, action: "react", removed: true, messageId, reactionId });
      }

      const rawEmoji =
        readStr(params, "emoji") ?? readStr(params, "emojiName") ?? readStr(params, "emojiType");

      const emojiType = normalizeFeishuEmoji(rawEmoji);

      const result = await addReactionFeishu({
        cfg,
        messageId,
        emojiType,
        accountId: resolvedAccountId,
      });

      return toJsonResult({ ok: true, action: "react", messageId, emojiType, ...result });
    }

    if (action === "reactions") {
      const messageId =
        readStr(params, "messageId") ??
        readStr(params, "message_id") ??
        (ctx.toolContext?.currentMessageId != null
          ? String(ctx.toolContext.currentMessageId)
          : undefined);

      if (!messageId) {
        throw new Error("messageId is required to list reactions.");
      }

      const emojiType = readStr(params, "emojiType");
      const reactions = await listReactionsFeishu({
        cfg,
        messageId,
        emojiType,
        accountId: resolvedAccountId,
      });

      return toJsonResult({ ok: true, action: "reactions", messageId, reactions });
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
