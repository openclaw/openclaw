import fs from "fs";
import os from "os";
import path from "path";
import type * as Lark from "@larksuiteoapi/node-sdk";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { encodeQuery, extractReplyText, isRecord, readString } from "./comment-shared.js";
import { parseFeishuCommentTarget, type CommentFileType } from "./comment-target.js";
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
    params?: Record<string, string | undefined>;
    data: unknown;
    timeout?: number;
  }): Promise<unknown>;
};

type FeishuDriveApiResponse<T> = {
  code: number;
  log_id?: string;
  msg?: string;
  data?: T;
};

class FeishuReplyCommentError extends Error {
  httpStatus?: number;
  feishuCode?: number | string;
  feishuMsg?: string;
  feishuLogId?: string;

  constructor(params: {
    message: string;
    httpStatus?: number;
    feishuCode?: number | string;
    feishuMsg?: string;
    feishuLogId?: string;
  }) {
    super(params.message);
    this.name = "FeishuReplyCommentError";
    this.httpStatus = params.httpStatus;
    this.feishuCode = params.feishuCode;
    this.feishuMsg = params.feishuMsg;
    this.feishuLogId = params.feishuLogId;
  }
}

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

type FeishuDriveToolContext = {
  deliveryContext?: {
    channel?: string;
    to?: string;
  };
};

const FEISHU_DRIVE_REQUEST_TIMEOUT_MS = 30_000;

function getDriveInternalClient(client: Lark.Client): FeishuDriveInternalClient {
  return client as FeishuDriveInternalClient;
}

function buildReplyElements(content: string) {
  return [{ type: "text", text: content }];
}

async function requestDriveApi<T>(params: {
  client: Lark.Client;
  method: "GET" | "POST";
  url: string;
  query?: Record<string, string | undefined>;
  data?: unknown;
}): Promise<T> {
  const internalClient = getDriveInternalClient(params.client);
  return (await internalClient.request({
    method: params.method,
    url: params.url,
    params: params.query ?? {},
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

function normalizeCommentPageSize(pageSize: number | undefined): string | undefined {
  if (typeof pageSize !== "number" || !Number.isFinite(pageSize)) {
    return undefined;
  }
  return String(Math.min(Math.max(Math.floor(pageSize), 1), 100));
}

function resolveAmbientCommentTarget(context: FeishuDriveToolContext | undefined) {
  const deliveryContext = context?.deliveryContext;
  if (deliveryContext?.channel && deliveryContext.channel !== "feishu") {
    return null;
  }
  return parseFeishuCommentTarget(deliveryContext?.to);
}

function applyAmbientCommentDefaults<
  T extends {
    file_token?: string;
    file_type?: CommentFileType;
    comment_id?: string;
  },
>(params: T, context: FeishuDriveToolContext | undefined): T {
  const ambient = resolveAmbientCommentTarget(context);
  if (!ambient) {
    return params;
  }
  return {
    ...params,
    file_token: params.file_token?.trim() || ambient.fileToken,
    file_type: params.file_type ?? ambient.fileType,
    comment_id: params.comment_id?.trim() || ambient.commentId,
  };
}

function applyAddCommentAmbientDefaults<
  T extends {
    file_token?: string;
    file_type?: "doc" | "docx";
  },
>(params: T, context: FeishuDriveToolContext | undefined): T {
  const ambient = resolveAmbientCommentTarget(context);
  if (!ambient || (ambient.fileType !== "doc" && ambient.fileType !== "docx")) {
    return params;
  }
  return {
    ...params,
    file_token: params.file_token?.trim() || ambient.fileToken,
    file_type: params.file_type ?? ambient.fileType,
  };
}

function applyAddCommentDefaults<
  T extends {
    file_token?: string;
    file_type?: "doc" | "docx";
  },
>(params: T): T & { file_type: "doc" | "docx" } {
  const fileType = params.file_type ?? "docx";
  if (!params.file_type) {
    console.info(
      `[feishu_drive] add_comment missing file_type; defaulting to docx ` +
        `file_token=${params.file_token ?? "unknown"}`,
    );
  }
  return {
    ...params,
    file_type: fileType,
  };
}

function applyCommentFileTypeDefault<
  T extends {
    file_token?: string;
    file_type?: CommentFileType;
  },
>(
  params: T,
  action: "list_comments" | "list_comment_replies" | "reply_comment",
): T & {
  file_type: CommentFileType;
} {
  const fileType = params.file_type ?? "docx";
  if (!params.file_type) {
    console.info(
      `[feishu_drive] ${action} missing file_type; defaulting to docx ` +
        `file_token=${params.file_token ?? "unknown"}`,
    );
  }
  return {
    ...params,
    file_type: fileType,
  };
}

function formatDriveApiError(error: unknown): string {
  if (!isRecord(error)) {
    return typeof error === "string" ? error : JSON.stringify(error);
  }
  const response = isRecord(error.response) ? error.response : undefined;
  const responseData = isRecord(response?.data) ? response?.data : undefined;
  return JSON.stringify({
    message:
      typeof error.message === "string"
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error),
    code: readString(error.code),
    method: readString(isRecord(error.config) ? error.config.method : undefined),
    url: readString(isRecord(error.config) ? error.config.url : undefined),
    params: isRecord(error.config) ? error.config.params : undefined,
    http_status: typeof response?.status === "number" ? response.status : undefined,
    feishu_code:
      typeof responseData?.code === "number" ? responseData.code : readString(responseData?.code),
    feishu_msg: readString(responseData?.msg),
    feishu_log_id: readString(responseData?.log_id),
  });
}

function extractDriveApiErrorMeta(error: unknown): {
  message: string;
  httpStatus?: number;
  feishuCode?: number | string;
  feishuMsg?: string;
  feishuLogId?: string;
} {
  if (!isRecord(error)) {
    return { message: typeof error === "string" ? error : JSON.stringify(error) };
  }
  const response = isRecord(error.response) ? error.response : undefined;
  const responseData = isRecord(response?.data) ? response?.data : undefined;
  return {
    message:
      typeof error.message === "string"
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error),
    httpStatus: typeof response?.status === "number" ? response.status : undefined,
    feishuCode:
      typeof responseData?.code === "number" ? responseData.code : readString(responseData?.code),
    feishuMsg: readString(responseData?.msg),
    feishuLogId: readString(responseData?.log_id),
  };
}

function isReplyNotAllowedError(error: unknown): boolean {
  if (!(error instanceof FeishuReplyCommentError)) {
    return false;
  }
  return error.feishuCode === 1069302;
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

async function getFileInfo(client: Lark.Client, fileToken: string, type?: string) {
  // Use batch_query meta API to look up file metadata directly by token.
  // This works for any file the bot has access to, regardless of folder membership.
  const docType = (type || "file") as
    | "doc"
    | "docx"
    | "sheet"
    | "bitable"
    | "file"
    | "wiki"
    | "mindnote"
    | "folder"
    | "synced_block"
    | "slides";
  const res = await client.drive.meta.batchQuery({
    data: {
      request_docs: [{ doc_token: fileToken, doc_type: docType }],
      with_url: true,
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const failed = res.data?.failed_list?.find((f: { token?: string }) => f.token === fileToken);
  if (failed) {
    throw new Error(
      `File not accessible (token: ${fileToken}, code: ${(failed as { code?: number }).code})`,
    );
  }

  const meta = res.data?.metas?.[0];
  if (!meta) {
    throw new Error(`File not found: ${fileToken}`);
  }

  return {
    token: meta.doc_token,
    name: meta.title,
    type: meta.doc_type,
    url: meta.url,
    owner_id: meta.owner_id,
    created_time: meta.create_time,
    modified_time: meta.latest_modify_time,
    latest_modify_user: meta.latest_modify_user,
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
          page_size: normalizeCommentPageSize(params.page_size),
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
          page_size: normalizeCommentPageSize(params.page_size),
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
): Promise<{ success: true } & Record<string, unknown>> {
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

// Fetch comment metadata via batch_query because the single-comment endpoint
// does not support partial comments.
async function queryCommentById(
  client: Lark.Client,
  params: {
    file_token: string;
    file_type: CommentFileType;
    comment_id: string;
  },
) {
  const response = assertDriveApiSuccess(
    await requestDriveApi<FeishuDriveListCommentsResponse>({
      client,
      method: "POST",
      url:
        `/open-apis/drive/v1/files/${encodeURIComponent(params.file_token)}/comments/batch_query` +
        encodeQuery({
          file_type: params.file_type,
          user_id_type: "open_id",
        }),
      data: {
        comment_ids: [params.comment_id],
      },
    }),
  );
  return response.data?.items?.find((comment) => comment.comment_id?.trim() === params.comment_id);
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
  const url = `/open-apis/drive/v1/files/${encodeURIComponent(params.file_token)}/comments/${encodeURIComponent(
    params.comment_id,
  )}/replies`;
  const query = { file_type: params.file_type };
  try {
    const response = await requestDriveApi<FeishuDriveApiResponse<Record<string, unknown>>>({
      client,
      method: "POST",
      url,
      query,
      data: {
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
    });
    if (response.code === 0) {
      return {
        success: true,
        ...response.data,
      };
    }
    console.warn(
      `[feishu_drive] replyComment failed ` +
        `comment=${params.comment_id} file_type=${params.file_type} ` +
        `code=${response.code ?? "unknown"} ` +
        `msg=${response.msg ?? "unknown"} log_id=${response.log_id ?? "unknown"}`,
    );
    throw new FeishuReplyCommentError({
      message: response.msg ?? "Feishu Drive reply comment failed",
      feishuCode: response.code,
      feishuMsg: response.msg,
      feishuLogId: response.log_id,
    });
  } catch (error) {
    if (error instanceof FeishuReplyCommentError) {
      throw error;
    }
    const meta = extractDriveApiErrorMeta(error);
    console.warn(
      `[feishu_drive] replyComment threw ` +
        `comment=${params.comment_id} file_type=${params.file_type} ` +
        `error=${formatDriveApiError(error)}`,
    );
    throw new FeishuReplyCommentError({
      message: meta.message,
      httpStatus: meta.httpStatus,
      feishuCode: meta.feishuCode,
      feishuMsg: meta.feishuMsg,
      feishuLogId: meta.feishuLogId,
    });
  }
}

export async function deliverCommentThreadText(
  client: Lark.Client,
  params: {
    file_token: string;
    file_type: CommentFileType;
    comment_id: string;
    content: string;
    is_whole_comment?: boolean;
  },
): Promise<
  | ({ success: true; reply_id?: string } & Record<string, unknown> & {
        delivery_mode: "reply_comment";
      })
  | ({ success: true; comment_id?: string } & Record<string, unknown> & {
        delivery_mode: "add_comment";
      })
> {
  let isWholeComment = params.is_whole_comment;
  if (isWholeComment === undefined) {
    try {
      const comment = await queryCommentById(client, params);
      isWholeComment = comment?.is_whole === true;
    } catch (error) {
      console.warn(
        `[feishu_drive] comment metadata preflight failed ` +
          `comment=${params.comment_id} file_type=${params.file_type} ` +
          `error=${formatErrorMessage(error)}`,
      );
      isWholeComment = false;
    }
  }
  if (isWholeComment) {
    if (params.file_type !== "doc" && params.file_type !== "docx") {
      throw new Error(
        `Whole-document comment follow-ups are only supported for doc/docx (got ${params.file_type})`,
      );
    }
    const wholeCommentFileType: "doc" | "docx" = params.file_type;
    console.info(
      `[feishu_drive] whole-comment compatibility path ` +
        `comment=${params.comment_id} file_type=${params.file_type} mode=add_comment`,
    );
    return {
      delivery_mode: "add_comment",
      ...(await addComment(client, {
        file_token: params.file_token,
        file_type: wholeCommentFileType,
        content: params.content,
      })),
    };
  }
  try {
    return {
      delivery_mode: "reply_comment",
      ...(await replyComment(client, params)),
    };
  } catch (error) {
    if (error instanceof FeishuReplyCommentError && isReplyNotAllowedError(error)) {
      if (params.file_type !== "doc" && params.file_type !== "docx") {
        throw error;
      }
      const fallbackFileType: "doc" | "docx" = params.file_type;
      console.info(
        `[feishu_drive] reply-not-allowed compatibility path ` +
          `comment=${params.comment_id} file_type=${params.file_type} mode=add_comment ` +
          `log_id=${error.feishuLogId ?? "unknown"}`,
      );
      return {
        delivery_mode: "add_comment",
        ...(await addComment(client, {
          file_token: params.file_token,
          file_type: fallbackFileType,
          content: params.content,
        })),
      };
    }
    throw error;
  }
}

// ============ PDF Text Extraction ============

async function extractPdfText(filePath: string): Promise<string | undefined> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(await fs.promises.readFile(filePath));
    const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdfjs item type
      const text = content.items
        .filter((item: { str?: string }) => "str" in item)
        .map((item: { str?: string }) => item.str)
        .join(" ");
      if (text.trim()) pages.push(text);
    }
    return pages.length > 0 ? pages.join("\n\n") : undefined;
  } catch {
    return undefined;
  }
}

// ============ File Extension Detection ============

const MIME_EXTENSION_MAP: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "application/zip": ".zip",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};

function detectFileExtension(headers: Record<string, string | undefined>): string {
  try {
    const disposition = headers["content-disposition"] ?? "";
    const fnMatch = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    if (fnMatch) {
      const ext = path.extname(decodeURIComponent(fnMatch[1]));
      if (ext) return ext;
    }

    const ct = headers["content-type"] ?? "";
    for (const [mime, extension] of Object.entries(MIME_EXTENSION_MAP)) {
      if (ct.includes(mime)) return extension;
    }
  } catch {
    // ignore header parsing errors
  }
  return "";
}

function detectFileName(headers: Record<string, string | undefined>): string {
  try {
    const disposition = headers["content-disposition"] ?? "";
    const fnMatch = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    if (fnMatch) return decodeURIComponent(fnMatch[1]);
  } catch {
    // ignore
  }
  return "";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type varies
function resolveResponseHeaders(resAny: any): Record<string, string | undefined> {
  const headers = resAny.headers ?? {};
  // Handle both plain-object and Headers (fetch-style) APIs
  if (typeof headers.get === "function") {
    return {
      "content-disposition": headers.get("content-disposition") ?? undefined,
      "content-type": headers.get("content-type") ?? undefined,
    };
  }
  return headers;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type varies
async function writeResponseToFile(resAny: any, filePath: string): Promise<void> {
  if (typeof resAny.writeFile === "function") {
    await resAny.writeFile(filePath);
  } else if (typeof resAny.getReadableStream === "function") {
    const stream = resAny.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    await fs.promises.writeFile(filePath, Buffer.concat(chunks));
  } else if (Buffer.isBuffer(resAny)) {
    await fs.promises.writeFile(filePath, resAny);
  } else if (resAny.data && Buffer.isBuffer(resAny.data)) {
    await fs.promises.writeFile(filePath, resAny.data);
  } else {
    throw new Error("Unexpected download response format");
  }
}

/** Strip path-traversal characters from tokens before using in file paths. */
function sanitizeToken(token: string): string {
  return token.replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function resolveDownloadsDir(): Promise<string> {
  const homeDir = os.homedir();
  const dlDir = path.join(homeDir, ".openclaw", "workspace", "downloads");
  await fs.promises.mkdir(dlDir, { recursive: true });
  return dlDir;
}

/** Try to extract readable text from a downloaded file. */
async function tryExtractText(
  filePath: string,
  ext: string,
  sizeBytes: number,
): Promise<string | undefined> {
  if (ext === ".pdf") {
    const text = await extractPdfText(filePath);
    if (text) return text;
  }

  // Try reading small files as UTF-8 text
  if (sizeBytes < 512 * 1024) {
    try {
      const buf = await fs.promises.readFile(filePath);
      const text = buf.toString("utf-8");
      const nonPrintable = text.replace(/[\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, "");
      if (text.length === 0) return undefined;
      if (nonPrintable.length / text.length < 0.05) {
        return text;
      }
    } catch {
      // not text, ignore
    }
  }
  return undefined;
}

// ============ Download Actions ============

async function downloadFile(client: Lark.Client, fileToken: string, fileType?: string) {
  // For native Lark docs (docx, doc, sheet, bitable), use export task API
  const nativeTypes = ["doc", "docx", "sheet", "bitable"];
  if (fileType && nativeTypes.includes(fileType)) {
    return await downloadViaExport(client, fileToken, fileType);
  }

  // For uploaded files (PDF, images, etc.), use direct download
  const res = await client.drive.file.download({
    path: { file_token: fileToken },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type
  const resAny = res as any;
  if (resAny.code !== undefined && resAny.code !== 0) {
    throw new Error(resAny.msg || `Download failed with code ${resAny.code}`);
  }

  const headers = resolveResponseHeaders(resAny);
  const ext = detectFileExtension(headers);
  const dlDir = await resolveDownloadsDir();
  const tmpPath = path.join(dlDir, `${sanitizeToken(fileToken)}_${Date.now()}${ext}`);

  await writeResponseToFile(resAny, tmpPath);

  const stat = await fs.promises.stat(tmpPath);
  const textContent = await tryExtractText(tmpPath, ext, stat.size);

  return {
    file_path: tmpPath,
    size_bytes: stat.size,
    text_content: textContent,
    note: textContent
      ? "File content extracted and included as text_content."
      : `Binary file saved to ${tmpPath}.`,
  };
}

async function downloadViaExport(client: Lark.Client, fileToken: string, fileType: string) {
  const exportType = fileType as "doc" | "sheet" | "bitable" | "docx";
  const createRes = await client.drive.exportTask.create({
    data: {
      file_extension: "pdf",
      token: fileToken,
      type: exportType,
    },
  });
  if (createRes.code !== 0) {
    throw new Error(createRes.msg || `Export task creation failed with code ${createRes.code}`);
  }
  const ticket = createRes.data?.ticket;
  if (!ticket) {
    throw new Error("No export task ticket returned");
  }

  // Poll for export task completion (max ~30 seconds)
  let exportToken: string | undefined;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const getRes = await client.drive.exportTask.get({
      params: { token: fileToken },
      path: { ticket },
    });
    if (getRes.code !== 0) {
      throw new Error(getRes.msg || `Export task query failed with code ${getRes.code}`);
    }
    const status = getRes.data?.result?.job_status;
    if (status === 0) {
      exportToken = getRes.data?.result?.file_token;
      break;
    } else if (status === 1 || status === 2) {
      continue;
    } else {
      throw new Error(
        `Export task failed with status ${status}: ${getRes.data?.result?.job_error_msg || "unknown error"}`,
      );
    }
  }
  if (!exportToken) {
    throw new Error("Export task timed out after 30 seconds");
  }

  const dlRes = await client.drive.exportTask.download({
    path: { file_token: exportToken },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type
  const dlAny = dlRes as any;
  const dlDir = await resolveDownloadsDir();
  const tmpPath = path.join(dlDir, `${sanitizeToken(fileToken)}_export_${Date.now()}.pdf`);

  await writeResponseToFile(dlAny, tmpPath);

  const stat = await fs.promises.stat(tmpPath);
  const textContent = await tryExtractText(tmpPath, ".pdf", stat.size);
  return {
    file_path: tmpPath,
    size_bytes: stat.size,
    exported_as: "pdf",
    text_content: textContent,
    note: textContent
      ? `Native ${fileType} exported as PDF; text content extracted above.`
      : `Native ${fileType} exported as PDF and saved to ${tmpPath}. Use the read tool to view it.`,
  };
}

// ============ Message Attachment Download ============

async function downloadMessageAttachment(
  client: Lark.Client,
  messageId: string,
  fileKey: string,
  resourceType: "image" | "file" = "file",
) {
  const response = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: fileKey },
    params: { type: resourceType },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK response type
  const resAny = response as any;
  if (resAny.code !== undefined && resAny.code !== 0) {
    throw new Error(resAny.msg || `Message resource download failed with code ${resAny.code}`);
  }

  const headers = resolveResponseHeaders(resAny);
  const ext = detectFileExtension(headers);
  const fileName = detectFileName(headers);
  const dlDir = await resolveDownloadsDir();
  const tmpPath = path.join(dlDir, `${sanitizeToken(fileKey)}_${Date.now()}${ext}`);

  await writeResponseToFile(resAny, tmpPath);

  const stat = await fs.promises.stat(tmpPath);
  const textContent = await tryExtractText(tmpPath, ext, stat.size);

  return {
    file_path: tmpPath,
    file_name: fileName || undefined,
    size_bytes: stat.size,
    text_content: textContent,
    note: textContent
      ? "File content extracted and included as text_content."
      : `Binary file saved to ${tmpPath}.`,
  };
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
          "Feishu cloud storage and message attachment operations. Actions: list, info, download, create_folder, move, delete, download_message_attachment, list_comments, list_comment_replies, add_comment, reply_comment. Use download_message_attachment with message_id + file_key for files shared in chat messages (file_v3_xxx tokens).",
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
                return jsonToolResult(await getFileInfo(client, p.file_token, p.type));
              case "create_folder":
                return jsonToolResult(await createFolder(client, p.name, p.folder_token));
              case "move":
                return jsonToolResult(await moveFile(client, p.file_token, p.type, p.folder_token));
              case "delete":
                return jsonToolResult(await deleteFile(client, p.file_token, p.type));
              case "download":
                return jsonToolResult(await downloadFile(client, p.file_token, p.type));
              case "download_message_attachment":
                return jsonToolResult(
                  await downloadMessageAttachment(
                    client,
                    p.message_id,
                    p.file_key,
                    (p.resource_type as "image" | "file") ?? "file",
                  ),
                );
              case "list_comments": {
                const resolved = applyCommentFileTypeDefault(
                  applyAmbientCommentDefaults(p, ctx),
                  "list_comments",
                );
                return jsonToolResult(await listComments(client, resolved));
              }
              case "list_comment_replies": {
                const resolved = applyCommentFileTypeDefault(
                  applyAmbientCommentDefaults(p, ctx),
                  "list_comment_replies",
                );
                return jsonToolResult(await listCommentReplies(client, resolved));
              }
              case "add_comment": {
                const resolved = applyAddCommentDefaults(applyAddCommentAmbientDefaults(p, ctx));
                return jsonToolResult(await addComment(client, resolved));
              }
              case "reply_comment": {
                const resolved = applyCommentFileTypeDefault(
                  applyAmbientCommentDefaults(p, ctx),
                  "reply_comment",
                );
                return jsonToolResult(await deliverCommentThreadText(client, resolved));
              }
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
