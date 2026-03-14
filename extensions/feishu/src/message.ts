import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
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

type MessageItem = {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  update_time?: string;
  chat_id?: string;
  deleted?: boolean;
  sender?: { id: string; id_type: string; sender_type: string; tenant_key?: string };
  body?: { content: string };
  mentions?: { key: string; id: string; id_type: string; name: string }[];
};

function pickMessageFields(item: MessageItem) {
  return {
    message_id: item.message_id,
    msg_type: item.msg_type,
    create_time: item.create_time,
    chat_id: item.chat_id,
    sender: item.sender,
    body: item.body,
    mentions: item.mentions,
  };
}

async function listMessages(
  client: Lark.Client,
  chatId: string,
  opts: {
    startTime?: string;
    endTime?: string;
    sortType?: string;
    pageSize?: number;
    pageToken?: string;
  },
) {
  const page_size = opts.pageSize ? Math.max(1, Math.min(50, opts.pageSize)) : 20;
  const res = await client.im.message.list({
    params: {
      container_id_type: "chat",
      container_id: chatId,
      start_time: opts.startTime,
      end_time: opts.endTime,
      sort_type: opts.sortType as "ByCreateTimeAsc" | "ByCreateTimeDesc" | undefined,
      page_size,
      page_token: opts.pageToken,
    },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    chat_id: chatId,
    has_more: res.data?.has_more,
    page_token: res.data?.page_token,
    items: res.data?.items?.map((item) => pickMessageFields(item as MessageItem)) ?? [],
  };
}

async function getMessage(client: Lark.Client, messageId: string) {
  const res = await client.im.message.get({
    path: { message_id: messageId },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const items = res.data?.items;
  if (!items || items.length === 0) {
    throw new Error(`Message not found: ${messageId}`);
  }

  return pickMessageFields(items[0] as MessageItem);
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
  if (!toolsCfg.message) {
    api.logger.debug?.("feishu_message: message tool disabled in config");
    return;
  }

  const getClient = () => createFeishuClient(firstAccount);

  api.registerTool(
    {
      name: "feishu_message",
      label: "Feishu Message",
      description:
        "Feishu message operations. Actions: list (chat history), get (single message by ID)",
      parameters: FeishuMessageSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuMessageParams;
        try {
          const client = getClient();
          switch (p.action) {
            case "list": {
              if (!p.chat_id) {
                return json({ error: "chat_id is required for list action" });
              }
              return json(
                await listMessages(client, p.chat_id, {
                  startTime: p.start_time,
                  endTime: p.end_time,
                  sortType: p.sort_type,
                  pageSize: p.page_size,
                  pageToken: p.page_token,
                }),
              );
            }
            case "get": {
              if (!p.message_id) {
                return json({ error: "message_id is required for get action" });
              }
              return json(await getMessage(client, p.message_id));
            }
            default:
              return json({ error: `Unknown action: ${String(p.action)}` });
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
