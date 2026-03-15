import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuReactionSchema, type FeishuReactionParams } from "./reaction-schema.js";
import {
  addReactionFeishu,
  removeReactionFeishu,
  listReactionsFeishu,
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

  const toolsCfg = resolveToolsConfig(accounts[0].config.tools);
  if (!toolsCfg.reaction) {
    api.logger.debug?.("feishu_reaction: reaction tool disabled in config");
    return;
  }

  api.registerTool(
    {
      name: "feishu_reaction",
      label: "Feishu Reaction",
      description:
        "Feishu message reaction operations. Actions: add (add emoji reaction to a message), remove (remove a reaction), list (list reactions on a message)",
      parameters: FeishuReactionSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuReactionParams;
        const cfg = api.config!;
        try {
          switch (p.action) {
            case "add": {
              const result = await addReactionFeishu({
                cfg,
                messageId: p.message_id,
                emojiType: p.emoji_type,
              });
              return json({ success: true, ...result });
            }
            case "remove": {
              await removeReactionFeishu({
                cfg,
                messageId: p.message_id,
                reactionId: p.reaction_id,
              });
              return json({ success: true });
            }
            case "list": {
              const reactions = await listReactionsFeishu({
                cfg,
                messageId: p.message_id,
                emojiType: p.emoji_type,
              });
              return json({ reactions });
            }
            default:
              return json({ error: `Unknown action: ${String((p as { action: string }).action)}` });
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
