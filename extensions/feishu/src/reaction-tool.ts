import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createActionGate } from "./channel-runtime-api.js";
import { normalizeFeishuEmojiType } from "./reaction-emoji.js";
import { FeishuReactionSchema, type FeishuReactionParams } from "./reaction-schema.js";
import {
  addReactionFeishu,
  listReactionsFeishu,
  removeOwnReactionFeishu,
  removeReactionFeishu,
} from "./reactions.js";
import { resolveFeishuToolAccount } from "./tool-account.js";
import {
  jsonToolResult,
  toolExecutionErrorResult,
  unknownToolActionResult,
} from "./tool-result.js";
import { resolveToolsConfig } from "./tools-config.js";
import type { ResolvedFeishuAccount } from "./types.js";

type FeishuReactionExecuteParams = FeishuReactionParams & { accountId?: string };

function areFeishuReactionToolsEnabled(params: {
  api: Pick<OpenClawPluginApi, "config">;
  account: ResolvedFeishuAccount;
}): boolean {
  if (!params.account.enabled || !params.account.configured) {
    return false;
  }
  if (!resolveToolsConfig(params.account.config.tools).reactions) {
    return false;
  }
  const gate = createActionGate(
    (params.account.config.actions ??
      (params.api.config?.channels?.feishu as { actions?: unknown } | undefined)
        ?.actions) as Record<string, boolean | undefined>,
  );
  return gate("reactions");
}

export function registerFeishuReactionTools(api: OpenClawPluginApi) {
  if (!api.config) {
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    return;
  }

  if (!accounts.some((account) => areFeishuReactionToolsEnabled({ api, account }))) {
    return;
  }

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: "feishu_reaction",
        label: "Feishu Reaction",
        description:
          "Feishu message reaction operations. Actions: add, remove, list. Use emoji_type values such as THUMBSUP, HEART, SMILE, CLAP, or OK.",
        parameters: FeishuReactionSchema,
        async execute(_toolCallId, params) {
          const p = params as FeishuReactionExecuteParams;
          try {
            const account = resolveFeishuToolAccount({
              api,
              executeParams: p,
              defaultAccountId,
            });
            if (!areFeishuReactionToolsEnabled({ api, account })) {
              throw new Error(
                `Feishu reaction tools are disabled for account "${account.accountId}".`,
              );
            }
            switch (p.action) {
              case "add": {
                const emojiType = normalizeFeishuEmojiType(p.emoji_type);
                const result = await addReactionFeishu({
                  cfg: api.config,
                  messageId: p.message_id,
                  emojiType,
                  accountId: account.accountId,
                });
                return jsonToolResult({
                  success: true,
                  message_id: p.message_id,
                  emoji_type: emojiType,
                  reaction_id: result.reactionId,
                });
              }
              case "remove": {
                if (p.reaction_id) {
                  await removeReactionFeishu({
                    cfg: api.config,
                    messageId: p.message_id,
                    reactionId: p.reaction_id,
                    accountId: account.accountId,
                  });
                  return jsonToolResult({
                    success: true,
                    message_id: p.message_id,
                    removed: { reaction_id: p.reaction_id },
                  });
                }
                if (!p.emoji_type) {
                  return jsonToolResult({
                    error: "reaction_id or emoji_type is required for action remove",
                  });
                }
                const emojiType = normalizeFeishuEmojiType(p.emoji_type);
                const ownReaction = await removeOwnReactionFeishu({
                  cfg: api.config,
                  messageId: p.message_id,
                  emojiType,
                  accountId: account.accountId,
                  appId: account.appId,
                });
                if (!ownReaction) {
                  return jsonToolResult({
                    success: true,
                    message_id: p.message_id,
                    emoji_type: emojiType,
                    removed: false,
                  });
                }
                return jsonToolResult({
                  success: true,
                  message_id: p.message_id,
                  emoji_type: emojiType,
                  removed: { reaction_id: ownReaction.reactionId },
                });
              }
              case "list": {
                const emojiType = p.emoji_type ? normalizeFeishuEmojiType(p.emoji_type) : undefined;
                const reactions = await listReactionsFeishu({
                  cfg: api.config,
                  messageId: p.message_id,
                  emojiType,
                  accountId: account.accountId,
                });
                return jsonToolResult({ message_id: p.message_id, reactions });
              }
              default:
                return unknownToolActionResult((p as { action?: unknown }).action);
            }
          } catch (err) {
            return toolExecutionErrorResult(err);
          }
        },
      };
    },
    { name: "feishu_reaction" },
  );
}
