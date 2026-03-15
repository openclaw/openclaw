import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuCardToolSchema, type FeishuCardToolParams } from "./card-schema.js";
import { sendCardFeishu, updateCardFeishu } from "./send.js";
import { resolveToolsConfig } from "./tools-config.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

export function registerFeishuCardTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_card: No config available, skipping card tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_card: No Feishu accounts configured, skipping card tools");
    return;
  }

  const firstAccount = accounts[0];
  const toolsCfg = resolveToolsConfig(firstAccount.config.tools);
  if (!toolsCfg.card) {
    api.logger.debug?.("feishu_card: card tool disabled in config");
    return;
  }

  api.registerTool(
    {
      name: "feishu_card",
      label: "Feishu Card",
      description:
        "Send or update Feishu interactive cards. " +
        "Actions: send (send a card to a chat), update (update an existing card by message_id)",
      parameters: FeishuCardToolSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuCardToolParams;
        const cfg = api.config!;
        const accountId = firstAccount.accountId;
        try {
          switch (p.action) {
            case "send": {
              if (!p.chat_id) {
                return json({ error: "chat_id is required for send action" });
              }
              if (!p.card) {
                return json({ error: "card is required" });
              }
              const result = await sendCardFeishu({
                cfg,
                to: p.chat_id,
                card: p.card,
                replyToMessageId: p.reply_to_message_id,
                replyInThread: p.reply_in_thread,
                accountId,
              });
              return json({
                success: true,
                message_id: result.messageId,
              });
            }
            case "update": {
              if (!p.message_id) {
                return json({ error: "message_id is required for update action" });
              }
              if (!p.card) {
                return json({ error: "card is required" });
              }
              await updateCardFeishu({
                cfg,
                messageId: p.message_id,
                card: p.card,
                accountId,
              });
              return json({
                success: true,
                message_id: p.message_id,
              });
            }
            default:
              return json({ error: `Unknown action: ${String(p.action)}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_card" },
  );

  api.logger.info?.("feishu_card: Registered feishu_card tool");
}
