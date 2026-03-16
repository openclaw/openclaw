import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuChatSchema, type FeishuChatParams } from "./chat-schema.js";
import { createFeishuClient } from "./client.js";
import { resolveAnyEnabledFeishuToolsConfig, resolveFeishuToolAccount } from "./tool-account.js";
import { resolveToolsConfig } from "./tools-config.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

async function getChatInfo(client: Lark.Client, chatId: string) {
  const res = await client.im.chat.get({ path: { chat_id: chatId } });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const chat = res.data;
  return {
    chat_id: chatId,
    name: chat?.name,
    description: chat?.description,
    owner_id: chat?.owner_id,
    tenant_key: chat?.tenant_key,
    user_count: chat?.user_count,
    chat_mode: chat?.chat_mode,
    chat_type: chat?.chat_type,
    join_message_visibility: chat?.join_message_visibility,
    leave_message_visibility: chat?.leave_message_visibility,
    membership_approval: chat?.membership_approval,
    moderation_permission: chat?.moderation_permission,
    avatar: chat?.avatar,
  };
}

async function getChatList(
  client: Lark.Client,
  pageSize?: number,
  pageToken?: string,
  sortType?: "ByCreateTimeAsc" | "ByActiveTimeDesc",
  userIdType?: "open_id" | "user_id" | "union_id",
) {
  const page_size = pageSize ? Math.max(1, Math.min(100, pageSize)) : 50;
  const res = await client.im.chat.list({
    params: {
      page_size,
      page_token: pageToken,
      sort_type: sortType,
      user_id_type: userIdType,
    },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    has_more: res.data?.has_more,
    page_token: res.data?.page_token,
    items:
      res.data?.items?.map((item) => ({
        chat_id: item.chat_id,
        name: item.name,
        description: item.description,
        owner_id: item.owner_id,
        owner_id_type: item.owner_id_type,
        avatar: item.avatar,
        external: item.external,
        tenant_key: item.tenant_key,
        labels: item.labels,
        chat_status: item.chat_status,
      })) ?? [],
  };
}

async function getChatMembers(
  client: Lark.Client,
  chatId: string,
  pageSize?: number,
  pageToken?: string,
  memberIdType?: "open_id" | "user_id" | "union_id",
) {
  const page_size = pageSize ? Math.max(1, Math.min(100, pageSize)) : 50;
  const res = await client.im.chatMembers.get({
    path: { chat_id: chatId },
    params: {
      page_size,
      page_token: pageToken,
      member_id_type: memberIdType ?? "open_id",
    },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    chat_id: chatId,
    has_more: res.data?.has_more,
    page_token: res.data?.page_token,
    members:
      res.data?.items?.map((item) => ({
        member_id: item.member_id,
        name: item.name,
        tenant_key: item.tenant_key,
        member_id_type: item.member_id_type,
      })) ?? [],
  };
}

export function registerFeishuChatTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_chat: No config available, skipping chat tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_chat: No Feishu accounts configured, skipping chat tools");
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.chat) {
    api.logger.debug?.("feishu_chat: chat tool disabled in config");
    return;
  }

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: "feishu_chat",
        label: "Feishu Chat",
        description:
          "Feishu chat operations. Actions: members (list members of a chat), info (get chat details), list (list all chats the bot has joined, no chat_id needed)",
        parameters: FeishuChatSchema,
        async execute(_toolCallId, params) {
          const p = params as FeishuChatParams;
          try {
            const resolvedAccount = resolveFeishuToolAccount({
              api,
              executeParams: p,
              defaultAccountId,
            });
            const accountToolsCfg = resolveToolsConfig(resolvedAccount.config.tools);
            if (!accountToolsCfg.chat) {
              return json({
                error: `chat tool is disabled for account "${resolvedAccount.accountId}"`,
              });
            }
            const client = createFeishuClient(resolvedAccount);
            switch (p.action) {
              case "list":
                return json(
                  await getChatList(client, p.page_size, p.page_token, p.sort_type, p.user_id_type),
                );
              case "members":
                if (!p.chat_id) {
                  return json({ error: "chat_id is required for members action" });
                }
                return json(
                  await getChatMembers(
                    client,
                    p.chat_id,
                    p.page_size,
                    p.page_token,
                    p.member_id_type,
                  ),
                );
              case "info":
                if (!p.chat_id) {
                  return json({ error: "chat_id is required for info action" });
                }
                return json(await getChatInfo(client, p.chat_id));
              default:
                return json({ error: `Unknown action: ${String(p.action)}` });
            }
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      };
    },
    { name: "feishu_chat" },
  );

  api.logger.info?.("feishu_chat: Registered feishu_chat tool");
}
