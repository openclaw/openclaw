import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { FeishuMessageSchema, type FeishuMessageParams } from "./message-schema.js";
import { resolveToolsConfig } from "./tools-config.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

/**
 * List messages in a chat.
 * Reference: https://open.feishu.cn/document/server-docs/im-v1/message-content-description/list
 */
async function listMessages(
  client: Lark.Client,
  chatId: string,
  startTime?: string,
  endTime?: string,
  pageSize?: number,
  pageToken?: string,
) {
  const page_size = pageSize ? Math.max(1, Math.min(50, pageSize)) : 20;

  const params: any = {
    path: { chat_id: chatId },
    params: {
      page_size,
      page_token: pageToken,
    },
  };

  if (startTime) {
    params.params.start_time = startTime;
  }
  if (endTime) {
    params.params.end_time = endTime;
  }

  const res = await client.im.message.list(params);

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    chat_id: chatId,
    has_more: res.data?.has_more,
    page_token: res.data?.page_token,
    items:
      res.data?.items?.map((item) => ({
        message_id: item.message_id,
        parent_id: item.parent_id,
        root_id: item.root_id,
        thread_id: item.thread_id,
        chat_type: item.chat_type,
        message_type: item.message_type,
        content: item.content,
        sender_id: item.sender_id,
        sender_type: item.sender_type,
        create_time: item.create_time,
        update_time: item.update_time,
      })) ?? [],
  };
}

/**
 * Recall (delete) a message.
 * Reference: https://open.feishu.cn/document/server-docs/im-v1/message-content-description/delete_json
 * Note: Messages can only be recalled within 2 minutes of sending.
 */
async function recallMessage(client: Lark.Client, chatId: string, messageId: string) {
  const res = await client.im.message.delete({
    path: { message_id: messageId },
    params: { chat_id: chatId },
  });

  if (res.code !== 0) {
    // Check if it's the "message too old to recall" error
    if (res.code === 99991662) {
      throw new Error("消息发送超过 2 分钟，无法撤回");
    }
    throw new Error(res.msg);
  }

  return {
    success: true,
    message_id: messageId,
    chat_id: chatId,
    action: "recalled",
  };
}

/**
 * Delete a message (alias for recall, but may have different permissions).
 * Same API as recall in Feishu.
 */
async function deleteMessage(client: Lark.Client, chatId: string, messageId: string) {
  return await recallMessage(client, chatId, messageId);
}

export function registerFeishuMessageTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_message: No config available, skipping message tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_message: No Feishu accounts configured, skipping message tools");
    return;
  }

  const firstAccount = accounts[0];
  const toolsCfg = resolveToolsConfig(firstAccount.config.tools);

  // Check if message tool is enabled (default: true)
  if (toolsCfg.message === false) {
    api.logger.debug?.("feishu_message: message tool disabled in config");
    return;
  }

  const getClient = () => createFeishuClient(firstAccount);

  api.registerTool(
    {
      name: "feishu_message",
      label: "Feishu Message",
      description:
        "Feishu 消息管理工具。支持列出消息 (list)、撤回消息 (recall)、删除消息 (delete)。撤回限制：消息发送后 2 分钟内。",
      parameters: FeishuMessageSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuMessageParams;
        try {
          const client = getClient();
          switch (p.action) {
            case "list":
              return json(
                await listMessages(
                  client,
                  p.chat_id,
                  p.start_time,
                  p.end_time,
                  p.page_size,
                  p.page_token,
                ),
              );
            case "recall":
              if (!p.message_id) {
                return json({ error: "recall 操作需要 message_id 参数" });
              }
              return json(await recallMessage(client, p.chat_id, p.message_id));
            case "delete":
              if (!p.message_id) {
                return json({ error: "delete 操作需要 message_id 参数" });
              }
              return json(await deleteMessage(client, p.chat_id, p.message_id));
            default:
              return json({ error: `未知操作：${String(p.action)}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_message" },
  );

  api.logger.info?.("feishu_message: Registered feishu_message tool");
}
