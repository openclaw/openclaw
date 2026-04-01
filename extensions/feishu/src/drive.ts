import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { type CommentFileType } from "./comment-target.js";
import { FeishuDriveSchema, type FeishuDriveParams } from "./drive-schema.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";
import {
  jsonToolResult,
  toolExecutionErrorResult,
  unknownToolActionResult,
} from "./tool-result.js";

// ============ Actions ============

type FeishuExplorerRootFolderMetaResponse = {
  code: number;
  msg?: string;
  data?: {
    token?: string;
  };
};

type FeishuDriveInternalClient = Lark.Client & {
  domain?: string;
  httpInstance: Pick<Lark.HttpInstance, "get">;
  request(params: {
    method: "GET" | "POST";
    url: string;
    data: unknown;
    timeout?: number;
  }): Promise<unknown>;
};

type FeishuDriveApiResponse<T> = {
  code: number;
  msg?: string;
  data?: T;
};

type FeishuDriveCommentReply = {
  reply_id?: string;
  user_id?: string;
  create_time?: number;
  update_time?: number;
  content?: {
    elements?: unknown[];
  };
};

type FeishuDriveCommentCard = {
  comment_id?: string;
  user_id?: string;
  create_time?: number;
  update_time?: number;
  is_solved?: boolean;
  is_whole?: boolean;
  has_more?: boolean;
  page_token?: string;
  quote?: string;
  reply_list?: {
    replies?: FeishuDriveCommentReply[];
  };
};

type FeishuDriveListCommentsResponse = FeishuDriveApiResponse<{
  has_more?: boolean;
  items?: FeishuDriveCommentCard[];
  page_token?: string;
}>;

type FeishuDriveListRepliesResponse = FeishuDriveApiResponse<{
  has_more?: boolean;
  items?: FeishuDriveCommentReply[];
  page_token?: string;
}>;

const FEISHU_DRIVE_REQUEST_TIMEOUT_MS = 30_000;

function getDriveInternalClient(client: Lark.Client): FeishuDriveInternalClient {
  return client as FeishuDriveInternalClient;
}

function encodeQuery(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const trimmed = value?.trim();
    if (trimmed) {
      search.set(key, trimmed);
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractCommentElementText(element: unknown): string | undefined {
  if (!isRecord(element)) {
    return undefined;
  }
  const type = readString(element.type)?.trim();
  if (type === "text_run" && isRecord(element.text_run)) {
    return (
      readString(element.text_run.content)?.trim() ||
      readString(element.text_run.text)?.trim() ||
      undefined
    );
  }
  if (type === "mention") {
    const mention = isRecord(element.mention) ? element.mention : undefined;
    const mentionName =
      readString(mention?.name)?.trim() ||
      readString(mention?.display_name)?.trim() ||
      readString(element.name)?.trim();
    return mentionName ? `@${mentionName}` : "@mention";
  }
  if (type === "docs_link") {
    const docsLink = isRecord(element.docs_link) ? element.docs_link : undefined;
    return (
      readString(docsLink?.text)?.trim() ||
      readString(docsLink?.url)?.trim() ||
      readString(element.text)?.trim() ||
      readString(element.url)?.trim() ||
      undefined
    );
  }
  return (
    readString(element.text)?.trim() ||
    readString(element.content)?.trim() ||
    readString(element.name)?.trim() ||
    undefined
  );
}

function extractReplyText(reply: FeishuDriveCommentReply | undefined): string | undefined {
  if (!reply || !isRecord(reply.content)) {
    return undefined;
  }
  const elements = Array.isArray(reply.content.elements) ? reply.content.elements : [];
  const text = elements
    .map(extractCommentElementText)
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("")
    .trim();
  return text || undefined;
}

function buildReplyElements(content: string) {
  return [{ type: "text", text: content }];
}

async function requestDriveApi<T>(params: {
  client: Lark.Client;
  method: "GET" | "POST";
  url: string;
  data?: unknown;
}): Promise<T> {
  const internalClient = getDriveInternalClient(params.client);
  return (await internalClient.request({
    method: params.method,
    url: params.url,
    data: params.data ?? {},
    timeout: FEISHU_DRIVE_REQUEST_TIMEOUT_MS,
  })) as T;
}

function assertDriveApiSuccess<T extends { code: number; msg?: string }>(response: T): T {
  if (response.code !== 0) {
    throw new Error(response.msg ?? "Feishu Drive API request failed");
  }
  return response;
}

function normalizeCommentReply(reply: FeishuDriveCommentReply) {
  return {
    reply_id: reply.reply_id,
    user_id: reply.user_id,
    create_time: reply.create_time,
    update_time: reply.update_time,
    text: extractReplyText(reply),
  };
}

function normalizeCommentCard(comment: FeishuDriveCommentCard) {
  const replies = comment.reply_list?.replies ?? [];
  const rootReply = replies[0];
  return {
    comment_id: comment.comment_id,
    user_id: comment.user_id,
    create_time: comment.create_time,
    update_time: comment.update_time,
    is_solved: comment.is_solved,
    is_whole: comment.is_whole,
    quote: comment.quote,
    text: extractReplyText(rootReply),
    has_more_replies: comment.has_more,
    replies_page_token: comment.page_token,
    replies: replies.slice(1).map(normalizeCommentReply),
  };
}

async function getRootFolderToken(client: Lark.Client): Promise<string> {
  // Use generic HTTP client to call the root folder meta API
  // as it's not directly exposed in the SDK
  const internalClient = getDriveInternalClient(client);
  const domain = internalClient.domain ?? "https://open.feishu.cn";
  const res = (await internalClient.httpInstance.get(
    `${domain}/open-apis/drive/explorer/v2/root_folder/meta`,
  )) as FeishuExplorerRootFolderMetaResponse;
  if (res.code !== 0) {
    throw new Error(res.msg ?? "Failed to get root folder");
  }
  const token = res.data?.token;
  if (!token) {
    throw new Error("Root folder token not found");
  }
  return token;
}

async function listFolder(client: Lark.Client, folderToken?: string) {
  // Filter out invalid folder_token values (empty, "0", etc.)
  const validFolderToken = folderToken && folderToken !== "0" ? folderToken : undefined;
  const res = await client.drive.file.list({
    params: validFolderToken ? { folder_token: validFolderToken } : {},
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    files:
      res.data?.files?.map((f) => ({
        token: f.token,
        name: f.name,
        type: f.type,
        url: f.url,
        created_time: f.created_time,
        modified_time: f.modified_time,
        owner_id: f.owner_id,
      })) ?? [],
    next_page_token: res.data?.next_page_token,
  };
}

async function getFileInfo(client: Lark.Client, fileToken: string, folderToken?: string) {
  // Use list with folder_token to find file info
  const res = await client.drive.file.list({
    params: folderToken ? { folder_token: folderToken } : {},
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const file = res.data?.files?.find((f) => f.token === fileToken);
  if (!file) {
    throw new Error(`File not found: ${fileToken}`);
  }

  return {
    token: file.token,
    name: file.name,
    type: file.type,
    url: file.url,
    created_time: file.created_time,
    modified_time: file.modified_time,
    owner_id: file.owner_id,
  };
}

async function createFolder(client: Lark.Client, name: string, folderToken?: string) {
  // Feishu supports using folder_token="0" as the root folder.
  // We *try* to resolve the real root token (explorer API), but fall back to "0"
  // because some tenants/apps return 400 for that explorer endpoint.
  let effectiveToken = folderToken && folderToken !== "0" ? folderToken : "0";
  if (effectiveToken === "0") {
    try {
      effectiveToken = await getRootFolderToken(client);
    } catch {
      // ignore and keep "0"
    }
  }

  const res = await client.drive.file.createFolder({
    data: {
      name,
      folder_token: effectiveToken,
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    token: res.data?.token,
    url: res.data?.url,
  };
}

async function moveFile(client: Lark.Client, fileToken: string, type: string, folderToken: string) {
  const res = await client.drive.file.move({
    path: { file_token: fileToken },
    data: {
      type: type as
        | "doc"
        | "docx"
        | "sheet"
        | "bitable"
        | "folder"
        | "file"
        | "mindnote"
        | "slides",
      folder_token: folderToken,
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
    task_id: res.data?.task_id,
  };
}

async function deleteFile(client: Lark.Client, fileToken: string, type: string) {
  const res = await client.drive.file.delete({
    path: { file_token: fileToken },
    params: {
      type: type as
        | "doc"
        | "docx"
        | "sheet"
        | "bitable"
        | "folder"
        | "file"
        | "mindnote"
        | "slides"
        | "shortcut",
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
    task_id: res.data?.task_id,
  };
}

async function listComments(
  client: Lark.Client,
  params: {
    file_token: string;
    file_type: CommentFileType;
    page_size?: number;
    page_token?: string;
  },
) {
  const response = assertDriveApiSuccess(
    await requestDriveApi<FeishuDriveListCommentsResponse>({
      client,
      method: "GET",
      url:
        `/open-apis/drive/v1/files/${encodeURIComponent(params.file_token)}/comments` +
        encodeQuery({
          file_type: params.file_type,
          page_size:
            typeof params.page_size === "number" && Number.isFinite(params.page_size)
              ? String(params.page_size)
              : undefined,
          page_token: params.page_token,
          user_id_type: "open_id",
        }),
    }),
  );
  return {
    has_more: response.data?.has_more ?? false,
    page_token: response.data?.page_token,
    comments: (response.data?.items ?? []).map(normalizeCommentCard),
  };
}

async function listCommentReplies(
  client: Lark.Client,
  params: {
    file_token: string;
    file_type: CommentFileType;
    comment_id: string;
    page_size?: number;
    page_token?: string;
  },
) {
  const response = assertDriveApiSuccess(
    await requestDriveApi<FeishuDriveListRepliesResponse>({
      client,
      method: "GET",
      url:
        `/open-apis/drive/v1/files/${encodeURIComponent(params.file_token)}/comments/${encodeURIComponent(
          params.comment_id,
        )}/replies` +
        encodeQuery({
          file_type: params.file_type,
          page_size:
            typeof params.page_size === "number" && Number.isFinite(params.page_size)
              ? String(params.page_size)
              : undefined,
          page_token: params.page_token,
          user_id_type: "open_id",
        }),
    }),
  );
  return {
    has_more: response.data?.has_more ?? false,
    page_token: response.data?.page_token,
    replies: (response.data?.items ?? []).map(normalizeCommentReply),
  };
}

async function addComment(
  client: Lark.Client,
  params: {
    file_token: string;
    file_type: "doc" | "docx";
    content: string;
    block_id?: string;
  },
) {
  if (params.block_id?.trim() && params.file_type !== "docx") {
    throw new Error("block_id is only supported for docx comments");
  }
  const response = assertDriveApiSuccess(
    await requestDriveApi<FeishuDriveApiResponse<Record<string, unknown>>>({
      client,
      method: "POST",
      url: `/open-apis/drive/v1/files/${encodeURIComponent(params.file_token)}/new_comments`,
      data: {
        file_type: params.file_type,
        reply_elements: buildReplyElements(params.content),
        ...(params.block_id?.trim() ? { anchor: { block_id: params.block_id.trim() } } : {}),
      },
    }),
  );
  return {
    success: true,
    ...response.data,
  };
}

export async function replyComment(
  client: Lark.Client,
  params: {
    file_token: string;
    file_type: CommentFileType;
    comment_id: string;
    content: string;
  },
): Promise<{ success: true; reply_id?: string } & Record<string, unknown>> {
  const url =
    `/open-apis/drive/v1/files/${encodeURIComponent(params.file_token)}/comments/${encodeURIComponent(
      params.comment_id,
    )}/replies` + encodeQuery({ file_type: params.file_type });
  const attempts: unknown[] = [
    {
      content: {
        elements: [
          {
            type: "text_run",
            text_run: {
              text: params.content,
            },
          },
        ],
      },
    },
    {
      reply_elements: buildReplyElements(params.content),
    },
  ];
  let lastMessage = "Feishu Drive reply comment failed";
  for (const data of attempts) {
    const response = (await requestDriveApi<FeishuDriveApiResponse<Record<string, unknown>>>({
      client,
      method: "POST",
      url,
      data,
    })) as FeishuDriveApiResponse<Record<string, unknown>>;
    if (response.code === 0) {
      return {
        success: true,
        ...response.data,
      };
    }
    lastMessage = response.msg ?? lastMessage;
  }
  throw new Error(lastMessage);
}

// ============ Tool Registration ============

export function registerFeishuDriveTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_drive: No config available, skipping drive tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_drive: No Feishu accounts configured, skipping drive tools");
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.drive) {
    api.logger.debug?.("feishu_drive: drive tool disabled in config");
    return;
  }

  type FeishuDriveExecuteParams = FeishuDriveParams & { accountId?: string };

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: "feishu_drive",
        label: "Feishu Drive",
        description:
          "Feishu cloud storage operations. Actions: list, info, create_folder, move, delete, list_comments, list_comment_replies, add_comment, reply_comment",
        parameters: FeishuDriveSchema,
        async execute(_toolCallId, params) {
          const p = params as FeishuDriveExecuteParams;
          try {
            const client = createFeishuToolClient({
              api,
              executeParams: p,
              defaultAccountId,
            });
            switch (p.action) {
              case "list":
                return jsonToolResult(await listFolder(client, p.folder_token));
              case "info":
                return jsonToolResult(await getFileInfo(client, p.file_token));
              case "create_folder":
                return jsonToolResult(await createFolder(client, p.name, p.folder_token));
              case "move":
                return jsonToolResult(await moveFile(client, p.file_token, p.type, p.folder_token));
              case "delete":
                return jsonToolResult(await deleteFile(client, p.file_token, p.type));
              case "list_comments":
                return jsonToolResult(await listComments(client, p));
              case "list_comment_replies":
                return jsonToolResult(await listCommentReplies(client, p));
              case "add_comment":
                return jsonToolResult(await addComment(client, p));
              case "reply_comment":
                return jsonToolResult(await replyComment(client, p));
              default:
                return unknownToolActionResult((p as { action?: unknown }).action);
            }
          } catch (err) {
            return toolExecutionErrorResult(err);
          }
        },
      };
    },
    { name: "feishu_drive" },
  );

  api.logger.info?.(`feishu_drive: Registered feishu_drive tool`);
}
