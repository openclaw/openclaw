import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { requestFeishuApi } from "./comment-shared.js";
import { FeishuMessageSchema, type FeishuMessageParams } from "./message-schema.js";
import { resolveAnyEnabledFeishuToolsConfig, resolveFeishuToolAccount } from "./tool-account.js";
import {
  jsonToolResult,
  toolExecutionErrorResult,
  unknownToolActionResult,
} from "./tool-result.js";
import { resolveToolsConfig } from "./tools-config.js";

type FeishuMessageExecuteParams = FeishuMessageParams & { accountId?: string };
type FeishuMessageAction = FeishuMessageExecuteParams["action"];
type FeishuMessageSortType = NonNullable<FeishuMessageExecuteParams["sort_type"]>;
type FeishuMessageUserIdType = NonNullable<FeishuMessageExecuteParams["user_id_type"]>;

const SORT_TYPE_VALUES = new Set<FeishuMessageSortType>(["ByCreateTimeAsc", "ByCreateTimeDesc"]);
const USER_ID_TYPE_VALUES = new Set<FeishuMessageUserIdType>(["open_id", "user_id", "union_id"]);

type FeishuMessageSender = {
  id?: string;
  id_type?: string;
  sender_type?: string;
};

type FeishuMessageListItem = {
  message_id?: string;
  parent_id?: string;
  root_id?: string;
  thread_id?: string;
  chat_id?: string;
  chat_type?: string;
  msg_type?: string;
  message_type?: string;
  body?: { content?: string };
  content?: string;
  sender?: FeishuMessageSender;
  sender_id?: string;
  sender_type?: string;
  create_time?: string;
  update_time?: string;
  deleted?: boolean;
  updated?: boolean;
};

type FeishuMessageListResponse = {
  code?: number;
  msg?: string;
  data?: {
    has_more?: boolean;
    page_token?: string;
    items?: FeishuMessageListItem[];
  };
};

type FeishuMessageDeleteResponse = {
  code?: number;
  msg?: string;
};

type FeishuMessageReadUser = {
  user_id_type?: string;
  user_id?: string;
  timestamp?: string;
  tenant_key?: string;
};

type FeishuMessageReadUsersResponse = {
  code?: number;
  msg?: string;
  data?: {
    has_more?: boolean;
    page_token?: string;
    items?: FeishuMessageReadUser[];
  };
};

type FeishuMessageClient = Lark.Client & {
  im: {
    message: {
      list(options: {
        params: {
          container_id_type: "chat";
          container_id: string;
          start_time?: string;
          end_time?: string;
          page_size: number;
          page_token?: string;
          sort_type?: "ByCreateTimeAsc" | "ByCreateTimeDesc";
        };
      }): Promise<FeishuMessageListResponse>;
      delete(options: { path: { message_id: string } }): Promise<FeishuMessageDeleteResponse>;
      readUsers(options: {
        params: {
          user_id_type: "open_id" | "user_id" | "union_id";
          page_size: number;
          page_token?: string;
        };
        path: { message_id: string };
      }): Promise<FeishuMessageReadUsersResponse>;
    };
  };
};

function asMessageClient(client: Lark.Client): FeishuMessageClient {
  return client as FeishuMessageClient;
}

function assertMessageApiSuccess(
  response: { code?: number; msg?: string },
  action: "delete" | "list" | "recall" | "read_receipts",
) {
  if (response.code === 0) {
    return;
  }
  if (response.code === 99991662) {
    throw new Error(
      `Feishu message ${action} failed: message is outside Feishu's allowed ${action} window`,
    );
  }
  const missingScope = parseMissingScope(response.msg);
  if (response.code === 230027 && missingScope) {
    throw new Error(`Feishu message ${action} failed: missing Feishu scope ${missingScope}`);
  }
  throw new Error(
    `Feishu message ${action} failed: ${response.msg || `code ${response.code ?? "unknown"}`}`,
  );
}

function parseMissingScope(message: string | undefined): string | undefined {
  return message?.match(/\bneed scope:\s*([A-Za-z0-9:._-]+)/i)?.[1];
}

function normalizeUnixSeconds(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(`${field} must be a Unix timestamp in seconds, encoded as a decimal string`);
  }
  return trimmed;
}

function requireToolString(
  value: string | undefined,
  field: "chat_id" | "message_id",
  action: FeishuMessageAction,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`feishu_message ${action} requires ${field}`);
  }
  return value.trim();
}

function normalizeOptionalToolString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeSortType(
  value: FeishuMessageSortType | undefined,
): FeishuMessageSortType | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!SORT_TYPE_VALUES.has(value)) {
    throw new Error("sort_type must be ByCreateTimeAsc or ByCreateTimeDesc");
  }
  return value;
}

function normalizeUserIdType(
  value: FeishuMessageUserIdType | undefined,
): FeishuMessageUserIdType | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!USER_ID_TYPE_VALUES.has(value)) {
    throw new Error("user_id_type must be open_id, user_id, or union_id");
  }
  return value;
}

function normalizePageSize(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 20;
  }
  return Math.min(Math.max(Math.floor(value), 1), 50);
}

function readRawContent(item: FeishuMessageListItem): string {
  return typeof item.body?.content === "string"
    ? item.body.content
    : typeof item.content === "string"
      ? item.content
      : "";
}

function readMessageType(item: FeishuMessageListItem): string {
  return item.msg_type ?? item.message_type ?? "unknown";
}

function parseMessageText(rawContent: string): string {
  if (!rawContent) {
    return "";
  }
  try {
    const parsed = JSON.parse(rawContent) as { text?: unknown; title?: unknown };
    if (typeof parsed.text === "string") {
      return parsed.text;
    }
    if (typeof parsed.title === "string") {
      return parsed.title;
    }
  } catch {
    return rawContent;
  }
  return rawContent;
}

function normalizeMessageItem(item: FeishuMessageListItem) {
  const rawContent = readRawContent(item);
  return {
    message_id: item.message_id,
    parent_id: item.parent_id,
    root_id: item.root_id,
    thread_id: item.thread_id,
    chat_id: item.chat_id,
    chat_type: item.chat_type,
    message_type: readMessageType(item),
    content: parseMessageText(rawContent),
    raw_content: rawContent,
    sender_id: item.sender?.id ?? item.sender_id,
    sender_id_type: item.sender?.id_type,
    sender_type: item.sender?.sender_type ?? item.sender_type,
    create_time: item.create_time,
    update_time: item.update_time,
    deleted: item.deleted,
    updated: item.updated,
  };
}

function normalizeReadUser(item: FeishuMessageReadUser) {
  return {
    user_id_type: item.user_id_type,
    user_id: item.user_id,
    timestamp: item.timestamp,
    tenant_key: item.tenant_key,
  };
}

export async function listFeishuMessages(
  client: Lark.Client,
  params: {
    chatId: string;
    startTime?: string;
    endTime?: string;
    pageSize?: number;
    pageToken?: string;
    sortType?: "ByCreateTimeAsc" | "ByCreateTimeDesc";
  },
) {
  const response = await requestFeishuApi(
    () =>
      asMessageClient(client).im.message.list({
        params: {
          container_id_type: "chat",
          container_id: params.chatId,
          start_time: normalizeUnixSeconds(params.startTime, "start_time"),
          end_time: normalizeUnixSeconds(params.endTime, "end_time"),
          page_size: normalizePageSize(params.pageSize),
          page_token: params.pageToken,
          sort_type: params.sortType ?? "ByCreateTimeDesc",
        },
      }),
    "Feishu message list failed",
    { includeNestedErrorLogId: true },
  );
  assertMessageApiSuccess(response, "list");
  return {
    chat_id: params.chatId,
    has_more: response.data?.has_more ?? false,
    page_token: response.data?.page_token,
    messages: (response.data?.items ?? []).map(normalizeMessageItem),
  };
}

export async function listFeishuMessageReadReceipts(
  client: Lark.Client,
  params: {
    messageId: string;
    userIdType?: "open_id" | "user_id" | "union_id";
    pageSize?: number;
    pageToken?: string;
  },
) {
  const userIdType = params.userIdType ?? "open_id";
  const response = await requestFeishuApi(
    () =>
      asMessageClient(client).im.message.readUsers({
        params: {
          user_id_type: userIdType,
          page_size: normalizePageSize(params.pageSize),
          page_token: params.pageToken,
        },
        path: { message_id: params.messageId },
      }),
    "Feishu message read_receipts failed",
    { includeNestedErrorLogId: true },
  );
  assertMessageApiSuccess(response, "read_receipts");
  return {
    message_id: params.messageId,
    user_id_type: userIdType,
    has_more: response.data?.has_more ?? false,
    page_token: response.data?.page_token,
    users: (response.data?.items ?? []).map(normalizeReadUser),
  };
}

export async function deleteFeishuMessage(
  client: Lark.Client,
  params: { messageId: string; chatId?: string },
) {
  const response = await requestFeishuApi(
    () =>
      asMessageClient(client).im.message.delete({
        path: { message_id: params.messageId },
      }),
    "Feishu message delete failed",
    { includeNestedErrorLogId: true },
  );
  assertMessageApiSuccess(response, "delete");
  return {
    success: true,
    action: "delete" as const,
    deleted: true,
    message_id: params.messageId,
    ...(params.chatId ? { chat_id: params.chatId } : {}),
  };
}

export async function recallFeishuMessage(
  client: Lark.Client,
  params: { messageId: string; chatId?: string },
) {
  const response = await requestFeishuApi(
    () =>
      asMessageClient(client).im.message.delete({
        path: { message_id: params.messageId },
      }),
    "Feishu message recall failed",
    { includeNestedErrorLogId: true },
  );
  assertMessageApiSuccess(response, "recall");
  return {
    success: true,
    action: "recall" as const,
    recalled: true,
    message_id: params.messageId,
    ...(params.chatId ? { chat_id: params.chatId } : {}),
  };
}

export function registerFeishuMessageTools(api: OpenClawPluginApi) {
  if (!api.config) {
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.messages) {
    return;
  }

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: "feishu_message",
        label: "Feishu Message",
        description:
          "Feishu message management. Actions: list messages in a chat, delete/recall a message, or query read receipts. start_time/end_time must be Unix seconds strings.",
        parameters: FeishuMessageSchema,
        async execute(_toolCallId, params) {
          const p = params as FeishuMessageExecuteParams;
          try {
            const account = resolveFeishuToolAccount({
              api,
              executeParams: p,
              defaultAccountId,
            });
            if (!resolveToolsConfig(account.config.tools).messages) {
              throw new Error(
                `Feishu message tools are disabled for account "${account.accountId}".`,
              );
            }
            const client = createFeishuClient(account);
            switch (p.action) {
              case "list":
                return jsonToolResult(
                  await listFeishuMessages(client, {
                    chatId: requireToolString(p.chat_id, "chat_id", p.action),
                    startTime: p.start_time,
                    endTime: p.end_time,
                    pageSize: p.page_size,
                    pageToken: p.page_token,
                    sortType: normalizeSortType(p.sort_type),
                  }),
                );
              case "read_receipts":
              case "read_users":
                return jsonToolResult(
                  await listFeishuMessageReadReceipts(client, {
                    messageId: requireToolString(p.message_id, "message_id", p.action),
                    userIdType: normalizeUserIdType(p.user_id_type),
                    pageSize: p.page_size,
                    pageToken: p.page_token,
                  }),
                );
              case "delete":
                return jsonToolResult(
                  await deleteFeishuMessage(client, {
                    messageId: requireToolString(p.message_id, "message_id", p.action),
                    chatId: normalizeOptionalToolString(p.chat_id),
                  }),
                );
              case "recall":
                return jsonToolResult(
                  await recallFeishuMessage(client, {
                    messageId: requireToolString(p.message_id, "message_id", p.action),
                    chatId: normalizeOptionalToolString(p.chat_id),
                  }),
                );
              default:
                return unknownToolActionResult((p as { action?: unknown }).action);
            }
          } catch (err) {
            return toolExecutionErrorResult(err);
          }
        },
      };
    },
    { name: "feishu_message" },
  );
}
