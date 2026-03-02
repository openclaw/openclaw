import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";
import { FeishuUrgentSchema, type FeishuUrgentParams } from "./urgent-schema.js";
import { urgentMessageFeishu } from "./urgent.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

export function registerFeishuUrgentTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_urgent: No config available, skipping");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_urgent: No Feishu accounts configured, skipping");
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.urgent) {
    api.logger.debug?.("feishu_urgent: urgent tool disabled in config");
    return;
  }

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: "feishu_urgent",
        label: "Feishu Urgent",
        description:
          "Send an urgent (buzz) notification for an existing Feishu message. " +
          "Supported urgent_type values: app (in-app buzz, default), sms (SMS push), phone (voice call). " +
          "Requires the message_id of an already-sent message and the open_id list of recipients to buzz. " +
          "Use this to escalate important messages that require immediate attention.",
        parameters: FeishuUrgentSchema,
        async execute(_toolCallId, params) {
          const p = params as FeishuUrgentParams;
          try {
            const client = createFeishuToolClient({
              api,
              executeParams: { accountId: p.account_id },
              defaultAccountId,
            });
            const result = await urgentMessageFeishu({
              client,
              messageId: p.message_id,
              userIds: p.user_ids,
              urgentType: p.urgent_type ?? "app",
            });
            return json({
              ok: true,
              message_id: p.message_id,
              urgent_type: p.urgent_type ?? "app",
              invalid_user_list: result.invalidUserList,
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      };
    },
    { name: "feishu_urgent" },
  );

  api.logger.info?.("feishu_urgent: Registered feishu_urgent tool");
}
