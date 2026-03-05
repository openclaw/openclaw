import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuChatSchema, type FeishuChatParams } from "./chat-schema.js";
import { createFeishuClient } from "./client.js";
import { resolveToolsConfig } from "./tools-config.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ── Existing actions ──────────────────────────────────────────────────────────

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

// ── Announcement actions ──────────────────────────────────────────────────────

const BLOCK_TYPE_NAMES: Record<number, string> = {
  1: "Page",
  2: "Text",
  3: "Heading1",
  4: "Heading2",
  5: "Heading3",
  12: "Bullet",
  13: "Ordered",
  14: "Code",
  15: "Quote",
  17: "Todo",
  18: "Bitable",
  21: "Diagram",
  22: "Divider",
  23: "File",
  27: "Image",
  30: "Sheet",
  31: "Table",
  32: "TableCell",
};

const STRUCTURED_BLOCK_TYPES = new Set([14, 18, 21, 23, 27, 30, 31, 32]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

async function getAnnouncement(client: AnyClient, chatId: string) {
  // docx.chatAnnouncement.get works for both doc and docx, and returns
  // announcement_type without triggering the noisy 232097 error from the legacy im API.
  const infoRes = await client.docx.chatAnnouncement.get({ path: { chat_id: chatId } });
  if (infoRes.code !== 0) throw new Error(infoRes.msg);

  const announcementType = infoRes.data?.announcement_type;

  if (announcementType === "doc") {
    const docRes = await client.im.chatAnnouncement.get({ path: { chat_id: chatId } });
    if (docRes.code !== 0) throw new Error(docRes.msg);
    return { announcement_type: "doc" as const, ...docRes.data };
  }

  // docx format: fetch blocks for full content
  const blocksRes = await client.docx.chatAnnouncementBlock.list({ path: { chat_id: chatId } });
  if (blocksRes.code !== 0) throw new Error(blocksRes.msg);

  const blocks: AnyClient[] = blocksRes.data?.items ?? [];
  const blockCounts: Record<string, number> = {};
  const structuredTypes: string[] = [];

  for (const b of blocks) {
    const type: number = b.block_type ?? 0;
    const name = BLOCK_TYPE_NAMES[type] || `type_${type}`;
    blockCounts[name] = (blockCounts[name] || 0) + 1;
    if (STRUCTURED_BLOCK_TYPES.has(type) && !structuredTypes.includes(name)) {
      structuredTypes.push(name);
    }
  }

  let hint: string | undefined;
  if (structuredTypes.length > 0) {
    hint = `This announcement contains ${structuredTypes.join(", ")} which are NOT included in the basic info. Use action: "list_announcement_blocks" to get full content.`;
  }

  return {
    announcement_type: "docx" as const,
    info: infoRes.data,
    blocks,
    block_count: blocks.length,
    block_types: blockCounts,
    ...(hint && { hint }),
  };
}

async function listAnnouncementBlocks(client: AnyClient, chatId: string) {
  const res = await client.docx.chatAnnouncementBlock.list({ path: { chat_id: chatId } });
  if (res.code !== 0) throw new Error(res.msg);
  return { blocks: res.data?.items ?? [] };
}

async function getAnnouncementBlock(client: AnyClient, chatId: string, blockId: string) {
  const res = await client.docx.chatAnnouncementBlock.get({
    path: { chat_id: chatId, block_id: blockId },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { block: res.data?.block };
}

async function writeDocAnnouncement(client: AnyClient, chatId: string, content: string) {
  const current = await client.im.chatAnnouncement.get({ path: { chat_id: chatId } });
  if (current.code !== 0) throw new Error(current.msg);

  const res = await client.im.chatAnnouncement.patch({
    path: { chat_id: chatId },
    data: { content, revision: current.data?.revision },
  });
  if (res.code !== 0) throw new Error(res.msg);

  return { success: true, announcement_type: "doc", ...res.data };
}

async function createTextBlock(
  client: AnyClient,
  chatId: string,
  parentBlockId: string,
  text: string,
) {
  const res = await client.docx.chatAnnouncementBlockChildren.create({
    path: { chat_id: chatId, block_id: parentBlockId },
    data: {
      children: [
        {
          block_type: 2,
          text: { elements: [{ text_run: { content: text } }] },
        },
      ],
    },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { success: true, block: res.data };
}

async function writeAnnouncement(client: AnyClient, chatId: string, content: string) {
  const current = await getAnnouncement(client, chatId);
  if (current.announcement_type === "doc") {
    return writeDocAnnouncement(client, chatId, content);
  }
  const pageBlock = (current.blocks as AnyClient[]).find((b: AnyClient) => b.block_type === 1);
  if (!pageBlock?.block_id) {
    return {
      error:
        "Could not find the Page root block for docx announcement. Use list_announcement_blocks to inspect the structure.",
    };
  }
  return createTextBlock(client, chatId, pageBlock.block_id, content);
}

async function appendAnnouncement(client: AnyClient, chatId: string, content: string) {
  const current = await getAnnouncement(client, chatId);
  if (current.announcement_type === "doc") {
    const existingContent = (current as AnyClient).content || "";
    return writeDocAnnouncement(client, chatId, existingContent + "\n" + content);
  }
  const pageBlock = (current.blocks as AnyClient[]).find((b: AnyClient) => b.block_type === 1);
  if (!pageBlock?.block_id) {
    return {
      error:
        "Could not find the Page root block for docx announcement. Use list_announcement_blocks to inspect the structure.",
    };
  }
  return createTextBlock(client, chatId, pageBlock.block_id, content);
}

async function updateAnnouncementBlock(
  client: AnyClient,
  chatId: string,
  blockId: string,
  content: string,
) {
  const info = await client.docx.chatAnnouncement.get({ path: { chat_id: chatId } });
  if (info.code !== 0) throw new Error(info.msg);

  const res = await client.docx.chatAnnouncementBlock.batchUpdate({
    path: { chat_id: chatId },
    params: { revision_id: info.data?.revision_id },
    data: {
      requests: [
        {
          block_id: blockId,
          update_text_elements: { elements: [{ text_run: { content } }] },
        },
      ],
    },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { success: true, ...res.data };
}

// ── Chat management actions ───────────────────────────────────────────────────

async function createChat(
  client: Lark.Client,
  name: string,
  userIds?: string[],
  description?: string,
) {
  const data: Record<string, unknown> = { name };
  if (userIds && userIds.length > 0) data.user_id_list = userIds;
  if (description) data.description = description;

  const res = await client.im.chat.create({ data, params: { user_id_type: "open_id" } });
  if (res.code !== 0) throw new Error(res.msg);

  return { success: true, chat_id: res.data?.chat_id, ...res.data };
}

async function addMembers(client: Lark.Client, chatId: string, userIds: string[]) {
  const res = await client.im.chatMembers.create({
    path: { chat_id: chatId },
    params: { member_id_type: "open_id" },
    data: { id_list: userIds },
  });
  if (res.code !== 0) throw new Error(res.msg);

  return { success: true, chat_id: chatId, added_user_ids: userIds, ...res.data };
}

async function checkBotInChat(client: Lark.Client, chatId: string) {
  try {
    const res = await client.im.chat.get({ path: { chat_id: chatId } });
    if (res.code !== 0) throw new Error(res.msg);
    return { success: true, chat_id: chatId, in_chat: true, chat_info: res.data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("90003")) {
      return { success: true, chat_id: chatId, in_chat: false, error: "Bot is not in this chat" };
    }
    throw err;
  }
}

async function deleteChat(client: Lark.Client, chatId: string) {
  const res = await client.im.chat.delete({ path: { chat_id: chatId } });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    success: true,
    chat_id: chatId,
    message: "Chat has been successfully disbanded/deleted",
    ...res.data,
  };
}

async function sendMessage(client: Lark.Client, chatId: string, content: string) {
  const res = await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text: content }),
    },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { success: true, message_id: res.data?.message_id, ...res.data };
}

async function createSessionChat(
  client: Lark.Client,
  name: string,
  userIds: string[],
  greeting?: string,
  description?: string,
) {
  const createResult = await createChat(client, name, userIds, description);
  const chatId = createResult.chat_id;

  if (!chatId) {
    return {
      success: false,
      error: "Failed to create chat - no chat_id returned",
      create_result: createResult,
    };
  }

  const greetingMessage = greeting ?? "Hello! I've created this group chat for us to collaborate.";

  try {
    const messageResult = await sendMessage(client, chatId, greetingMessage);
    return {
      success: true,
      chat_id: chatId,
      create_result: createResult,
      message_result: messageResult,
    };
  } catch (err) {
    return {
      success: true,
      chat_id: chatId,
      create_result: createResult,
      message_error: err instanceof Error ? err.message : "Failed to send greeting message",
    };
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

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

  const firstAccount = accounts[0];
  const toolsCfg = resolveToolsConfig(firstAccount.config.tools);
  if (!toolsCfg.chat) {
    api.logger.debug?.("feishu_chat: chat tool disabled in config");
    return;
  }

  const getClient = () => createFeishuClient(firstAccount);

  api.registerTool(
    {
      name: "feishu_chat",
      label: "Feishu Chat",
      description:
        "Feishu chat operations. Actions: members, info, get_announcement, list_announcement_blocks, get_announcement_block, write_announcement, append_announcement, update_announcement_block, create_chat, add_members, check_bot_in_chat, delete_chat, create_session_chat",
      parameters: FeishuChatSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuChatParams;
        try {
          const client = getClient();
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const chatId = p.chat_id!;
          switch (p.action) {
            case "members":
              return json(
                await getChatMembers(client, chatId, p.page_size, p.page_token, p.member_id_type),
              );
            case "info":
              return json(await getChatInfo(client, chatId));
            case "get_announcement":
              return json(await getAnnouncement(client, chatId));
            case "list_announcement_blocks":
              return json(await listAnnouncementBlocks(client, chatId));
            case "get_announcement_block":
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              return json(await getAnnouncementBlock(client, chatId, p.block_id!));
            case "write_announcement":
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              return json(await writeAnnouncement(client, chatId, p.content!));
            case "append_announcement":
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              return json(await appendAnnouncement(client, chatId, p.content!));
            case "update_announcement_block":
              return json(
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                await updateAnnouncementBlock(client, chatId, p.block_id!, p.content!),
              );
            case "create_chat":
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              return json(await createChat(client, p.name!, p.user_ids, p.description));
            case "add_members":
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              return json(await addMembers(client, chatId, p.user_ids!));
            case "check_bot_in_chat":
              return json(await checkBotInChat(client, chatId));
            case "delete_chat":
              return json(await deleteChat(client, chatId));
            case "create_session_chat":
              return json(
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                await createSessionChat(client, p.name!, p.user_ids!, p.greeting, p.description),
              );
            default:
              return json({ error: `Unknown action: ${String((p as { action: string }).action)}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    },
    { name: "feishu_chat" },
  );

  api.logger.info?.("feishu_chat: Registered feishu_chat tool");
}
