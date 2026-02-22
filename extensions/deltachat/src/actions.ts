import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelToolSend,
} from "openclaw/plugin-sdk";
import { readStringParam } from "openclaw/plugin-sdk";
import { resolveDeltaChatAccount } from "./accounts.js";
import { sendDeltaChatMessage } from "./outbound.js";
import {
  resolveDeltaChatReactionLevel,
  sendReactionDeltaChat,
  removeReactionDeltaChat,
  normalizeDeltaChatReactionParams,
} from "./reactions.js";
import { sendMediaDeltaChat } from "./send.js";

function jsonResult(payload: unknown): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

export function createDeltachatActions(): ChannelMessageActionAdapter {
  return {
    listActions: ({ cfg }) => {
      const account = resolveDeltaChatAccount({ cfg, accountId: "default" });
      const actions = account.config.actions ?? {};

      const enabledActions = new Set<ChannelMessageActionName>(["send"]);

      // Check reaction level and action gate
      const reactionLevel = resolveDeltaChatReactionLevel({ cfg });
      if (reactionLevel.agentReactionsEnabled && actions.reactions !== false) {
        enabledActions.add("react");
        enabledActions.add("reactions");
      }

      return Array.from(enabledActions);
    },

    extractToolSend: ({ args }): ChannelToolSend | null => {
      const action = typeof args.action === "string" ? args.action.trim() : "";
      if (action !== "sendMessage") {
        return null;
      }
      const to = typeof args.to === "string" ? args.to : undefined;
      if (!to) {
        return null;
      }
      const accountId = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
      return { to, accountId };
    },

    handleAction: async (ctx: ChannelMessageActionContext): Promise<AgentToolResult<unknown>> => {
      const { action, params, cfg } = ctx;
      const accountId = ctx.accountId ?? undefined;

      if (action === "send") {
        const to = readStringParam(params, "to", { required: true });
        const content = readStringParam(params, "message", {
          required: true,
          allowEmpty: true,
        });
        const mediaUrl = readStringParam(params, "media", { trim: false });
        const replyToId = readStringParam(params, "replyTo");

        if (mediaUrl) {
          const result = await sendMediaDeltaChat({
            cfg,
            to,
            text: content,
            mediaUrl,
            accountId,
            replyToMessageId: replyToId ? Number(replyToId) : undefined,
          });
          return jsonResult(result);
        } else {
          const result = await sendDeltaChatMessage({
            cfg,
            to,
            text: content,
            accountId,
            replyToId,
          });
          return jsonResult(result);
        }
      }

      if (action === "react") {
        const target = readStringParam(params, "to") ?? readStringParam(params, "target");
        const messageId = readStringParam(params, "messageId", { required: true });
        const emoji = readStringParam(params, "emoji", { allowEmpty: true });
        const remove = typeof params.remove === "boolean" ? params.remove : undefined;

        // Check reaction level configuration
        const reactionLevel = resolveDeltaChatReactionLevel({ cfg, accountId });
        if (!reactionLevel.agentReactionsEnabled) {
          return jsonResult({
            ok: false,
            error: `Reactions are disabled (reactionLevel: ${reactionLevel.level})`,
          });
        }

        // Check action gate for backward compatibility
        const account = resolveDeltaChatAccount({ cfg, accountId });
        if (account.config.actions?.reactions === false) {
          return jsonResult({
            ok: false,
            error: "Reactions are disabled via actions.reactions configuration",
          });
        }

        if (!target || !messageId) {
          return jsonResult({
            ok: false,
            error: "Target and messageId are required for reactions",
          });
        }

        try {
          const normalized = normalizeDeltaChatReactionParams({
            target: String(target),
            messageId: String(messageId),
            emoji,
            remove: remove ?? false,
          });

          if (normalized.remove) {
            const result = await removeReactionDeltaChat(
              normalized.chatId,
              normalized.messageId,
              normalized.emoji,
              { accountId },
            );
            return jsonResult(result);
          } else {
            const result = await sendReactionDeltaChat(
              normalized.chatId,
              normalized.messageId,
              normalized.emoji!,
              { accountId },
            );
            return jsonResult(result);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return jsonResult({
            ok: false,
            error: `Failed to send reaction: ${errorMessage}`,
          });
        }
      }

      if (action === "reactions") {
        const target = readStringParam(params, "to") ?? readStringParam(params, "target");
        const messageId = readStringParam(params, "messageId", { required: true });

        if (!target || !messageId) {
          return jsonResult({
            ok: false,
            error: "Target and messageId are required for reactions",
          });
        }

        try {
          const normalized = normalizeDeltaChatReactionParams({
            target: String(target),
            messageId: String(messageId),
            emoji: "",
            remove: false,
          });

          const { getReactionsDeltaChat } = await import("./reactions.js");
          const reactions = await getReactionsDeltaChat(normalized.chatId, normalized.messageId, {
            accountId,
          });

          return jsonResult({
            ok: true,
            data: { reactions },
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return jsonResult({
            ok: false,
            error: `Failed to get reactions: ${errorMessage}`,
          });
        }
      }

      return jsonResult({
        ok: false,
        error: `Action "${action}" is not supported by Delta.Chat`,
      });
    },
  };
}

export const deltachatMessageActions = createDeltachatActions();
