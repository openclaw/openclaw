import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { FeishuReactionSchema, type FeishuReactionParams } from "./reaction-schema.js";
import {
  addReactionFeishu,
  removeReactionFeishu,
  listReactionsFeishu,
  FeishuEmoji,
} from "./reactions.js";
import { resolveToolsConfig } from "./tools-config.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

export function registerFeishuReactionTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_reaction: No config available, skipping reaction tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_reaction: No Feishu accounts configured, skipping reaction tools");
    return;
  }

  const firstAccount = accounts[0];
  const toolsCfg = resolveToolsConfig(firstAccount.config.tools);
  if (!toolsCfg.reaction) {
    api.logger.debug?.("feishu_reaction: reaction tool disabled in config");
    return;
  }

  api.registerTool(
    {
      name: "feishu_reaction",
      label: "Feishu Reaction",
      description:
        "Feishu message reaction operations. Actions: add, remove, list. Common emojis: THUMBSUP, HEART, SMILE, FIRE, CLAP, OK, PRAY",
      parameters: FeishuReactionSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuReactionParams;
        try {
          switch (p.action) {
            case "add": {
              if (!p.emoji_type) {
                return json({ error: "emoji_type is required for add action" });
              }
              const result = await addReactionFeishu({
                cfg: api.config,
                messageId: p.message_id,
                emojiType: p.emoji_type,
                accountId: p.account_id,
              });
              return json({ success: true, ...result });
            }
            case "remove": {
              if (!p.reaction_id) {
                return json({ error: "reaction_id is required for remove action" });
              }
              await removeReactionFeishu({
                cfg: api.config,
                messageId: p.message_id,
                reactionId: p.reaction_id,
                accountId: p.account_id,
              });
              return json({ success: true, action: "removed" });
            }
            case "list": {
              const reactions = await listReactionsFeishu({
                cfg: api.config,
                messageId: p.message_id,
                emojiType: p.emoji_type,
                accountId: p.account_id,
              });
              return json({ reactions });
            }
            default:
              return json({ error: `Unknown action: ${String(p.action)}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_reaction" },
  );

  api.logger.info?.("feishu_reaction: Registered feishu_reaction tool");
}
