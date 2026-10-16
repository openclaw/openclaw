import type * as Lark from "@larksuiteoapi/node-sdk";
import {
  formatErrorMessage,
  PlatformMessageNotDispatchedError,
} from "openclaw/plugin-sdk/error-runtime";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { assertFeishuApiSuccess } from "./api-response.js";
import { cleanupAmbientCommentTypingReaction } from "./comment-reaction.js";
import {
  encodeQuery,
  extractFeishuApiErrorMeta,
  extractReplyText,
  FeishuReplyCommentError,
  formatFeishuApiError,
  type FeishuDriveCommentCard,
  type FeishuDriveCommentReply,
} from "./comment-shared.js";
import { parseFeishuCommentTarget, type CommentFileType } from "./comment-target.js";
import { FeishuDriveSchema, type FeishuDriveParams } from "./drive-schema.js";
import { withFeishuMessageDispatch } from "./send-context.js";
import { createFeishuToolClient } from "./tool-account.js";
import { registerFeishuTool } from "./tool-registration.js";
import { feishuExternalToolResult as jsonResult, unknownToolActionResult } from "./tool-result.js";

type FeishuExplorerRootFolderMetaResponse = {
  code: number;
  msg?: string;
  data?: {
    token?: string;
  };
};

type FeishuDriveApiResponse<T> = {
  code: number;
  log_id?: string;
  msg?: string;
  data?: T;
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

function requestDriveApi<T>(params: {
  client: Lark.Client;
  method: "GET" | "POST";
  url: string;
  query?: Record<string, string | undefined>;
  data?: unknown;
}): Promise<T> {
  return params.client.request<T>({
    method: params.method,
    url: params.url,
    params: params.query ?? {},
    data: params.data ?? {},
    timeout: FEISHU_DRIVE_REQUEST_TIMEOUT_MS,
  });
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

function resolveDriveCommentParams<
  T extends {
    action: "list_comments" | "list_comment_replies" | "add_comment" | "reply_comment";
    file_token?: string;
    file_type?: CommentFileType;
    comment_id?: string;
  },
>(params: T, context: OpenClawPluginToolContext): T & { file_type: CommentFileType } {
  const { action } = params;
  const delivery = context.deliveryContext;
  const ambient =
    delivery?.channel && delivery.channel !== "feishu"
      ? null
      : parseFeishuCommentTarget(delivery?.to);
  let resolved = params;
  if (
    ambient &&
    (action !== "add_comment" || ambient.fileType === "doc" || ambient.fileType === "docx")
  ) {
    resolved = {
      ...params,
      file_token: params.file_token?.trim() || ambient.fileToken,
      file_type: params.file_type ?? ambient.fileType,
      ...(action !== "add_comment" && {
        comment_id: params.comment_id?.trim() || ambient.commentId,
      }),
    };
  }
  const fileType = resolved.file_type ?? "docx";
  if (!resolved.file_type) {
    console.info(
      `[feishu_drive] ${action} missing file_type; defaulting to docx ` +
        `file_token=${resolved.file_token ?? "unknown"}`,
    );
  }
  return {
    ...resolved,
    file_type: fileType,
  };
}

async function listFolder(client: Lark.Client, params: Record<string, unknown> = {}) {
  const folderToken =
    typeof params.folder_token === "string" ? params.folder_token.trim() : undefined;
  const validFolderToken = folderToken && folderToken !== "0" ? folderToken : undefined;
  const pageSize = readPositiveIntegerParam(params, "page_size", {
    max: 200,
    message: "page_size must be a positive integer between 1 and 200",
  });
  const pageToken = typeof params.page_token === "string" ? params.page_token.trim() : undefined;

  // Bot credentials have no browsable root. A continuation cursor is only valid with the
  // same concrete folder token that produced it, so do not forward pagination for root.
  const listParams = validFolderToken
    ? {
        folder_token: validFolderToken,
        ...(pageSize ? { page_size: pageSize } : {}),
        ...(pageToken ? { page_token: pageToken } : {}),
      }
    : {};
  const res = await client.drive.file.list({
    params: listParams,
  });
  assertFeishuApiSuccess(res);

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

async function getRootFileInfo(client: Lark.Client, fileToken: string) {
  const { files } = await listFolder(client);
  const file = files.find((candidate) => candidate.token === fileToken);
  if (!file) {
    throw new Error(`File not found: ${fileToken}`);
  }

  return file;
}

async function getFileInfo(
  client: Lark.Client,
  fileToken: string,
  type: Extract<FeishuDriveParams, { action: "info" }>["type"],
) {
  if (type === "shortcut") {
    // The metadata API does not accept shortcut as a document type. Keep the existing
    // root-list behavior so the advertised shortcut info contract does not regress.
    return getRootFileInfo(client, fileToken);
  }

  let res: Awaited<ReturnType<Lark.Client["drive"]["meta"]["batchQuery"]>>;
  try {
    res = await client.drive.meta.batchQuery({
      data: {
        request_docs: [{ doc_token: fileToken, doc_type: type }],
        with_url: true,
      },
    });
  } catch (error) {
    if (extractFeishuApiErrorMeta(error).feishuCode === 99991672) {
      // Existing read-only apps may not have the newer metadata scope. Preserve their
      // root-file lookup while allowing scoped apps to resolve files in any shared folder.
      return getRootFileInfo(client, fileToken);
    }
    throw error;
  }
  if (res.code === 99991672) {
    return getRootFileInfo(client, fileToken);
  }
  assertFeishuApiSuccess(res);

  const file = res.data?.metas?.find(
    (meta) => meta.doc_token === fileToken || meta.request_doc_info?.doc_token === fileToken,
  );
  if (!file) {
    throw new Error(`File not found: ${fileToken}`);
  }

  return {
    token: file.doc_token,
    name: file.title,
    type: file.doc_type,
    url: file.url,
    created_time: file.create_time,
    modified_time: file.latest_modify_time,
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
      const domain = client.domain ?? "https://open.feishu.cn";
      const root = await client.httpInstance.get<FeishuExplorerRootFolderMetaResponse>(
        `${domain}/open-apis/drive/explorer/v2/root_folder/meta`,
      );
      if (root.code === 0 && root.data?.token) {
        effectiveToken = root.data.token;
      }
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
  assertFeishuApiSuccess(res);

  return {
    token: res.data?.token,
    url: res.data?.url,
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
    await withFeishuMessageDispatch(() =>
      requestDriveApi<FeishuDriveApiResponse<Record<string, unknown>>>({
        client,
        method: "POST",
        url: `/open-apis/drive/v1/files/${encodeURIComponent(params.file_token)}/new_comments`,
        data: {
          file_type: params.file_type,
          reply_elements: [{ type: "text", text: params.content }],
          ...(params.block_id?.trim() ? { anchor: { block_id: params.block_id.trim() } } : {}),
        },
      }),
    ),
  );
  return {
    success: true,
    ...response.data,
  };
}

async function replyComment(
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
    const response = await withFeishuMessageDispatch(() =>
      requestDriveApi<FeishuDriveApiResponse<Record<string, unknown>>>({
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
      }),
    );
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
    if (
      error instanceof FeishuReplyCommentError ||
      error instanceof PlatformMessageNotDispatchedError
    ) {
      throw error;
    }
    const meta = extractFeishuApiErrorMeta(error);
    console.warn(
      `[feishu_drive] replyComment threw ` +
        `comment=${params.comment_id} file_type=${params.file_type} ` +
        `error=${formatFeishuApiError(error, { includeConfigParams: true })}`,
    );
    throw new FeishuReplyCommentError(meta);
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
      // The single-comment endpoint does not support partial comments.
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
      const comment = response.data?.items?.find(
        (item) => item.comment_id?.trim() === params.comment_id,
      );
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
    console.info(
      `[feishu_drive] whole-comment compatibility path ` +
        `comment=${params.comment_id} file_type=${params.file_type} mode=add_comment`,
    );
  } else {
    try {
      return {
        delivery_mode: "reply_comment",
        ...(await replyComment(client, params)),
      };
    } catch (error) {
      if (!(error instanceof FeishuReplyCommentError) || error.feishuCode !== 1069302) {
        throw error;
      }
      if (params.file_type !== "doc" && params.file_type !== "docx") {
        throw error;
      }
      console.info(
        `[feishu_drive] reply-not-allowed compatibility path ` +
          `comment=${params.comment_id} file_type=${params.file_type} mode=add_comment ` +
          `log_id=${error.feishuLogId ?? "unknown"}`,
      );
    }
  }
  return {
    delivery_mode: "add_comment",
    ...(await addComment(client, {
      file_token: params.file_token,
      file_type: params.file_type,
      content: params.content,
    })),
  };
}

export function registerFeishuDriveTools(api: OpenClawPluginApi) {
  registerFeishuTool(api, {
    family: "drive",
    name: "feishu_drive",
    label: "Feishu Drive",
    description:
      "Feishu cloud storage operations. Actions: list, info, create_folder, move, delete, list_comments, list_comment_replies, add_comment, reply_comment",
    parameters: FeishuDriveSchema,
    createExecute(ctx, cfg) {
      const defaultAccountId = ctx.agentAccountId;
      return async (p) => {
        const client = createFeishuToolClient({
          cfg,
          executeParams: p,
          defaultAccountId,
          requiredTool: { family: "drive", label: "Drive" },
        });
        switch (p.action) {
          case "list":
            return jsonResult(await listFolder(client, p));
          case "info":
            return jsonResult(await getFileInfo(client, p.file_token, p.type));
          case "create_folder":
            return jsonResult(await createFolder(client, p.name, p.folder_token));
          case "move":
          case "delete": {
            const path = { file_token: p.file_token };
            const res =
              p.action === "move"
                ? await client.drive.file.move({
                    path,
                    data: {
                      type: p.type as
                        | "doc"
                        | "docx"
                        | "sheet"
                        | "bitable"
                        | "folder"
                        | "file"
                        | "mindnote"
                        | "slides",
                      folder_token: p.folder_token,
                    },
                  })
                : await client.drive.file.delete({ path, params: { type: p.type } });
            assertFeishuApiSuccess(res);
            return jsonResult({ success: true, task_id: res.data?.task_id });
          }
          case "list_comments":
          case "list_comment_replies": {
            const resolved = resolveDriveCommentParams(p, ctx);
            const filePath = `/open-apis/drive/v1/files/${encodeURIComponent(resolved.file_token)}/comments`;
            const isReplies = resolved.action === "list_comment_replies";
            const url = isReplies
              ? `${filePath}/${encodeURIComponent(resolved.comment_id)}/replies`
              : filePath;
            const response = assertDriveApiSuccess(
              await requestDriveApi<
                FeishuDriveListCommentsResponse | FeishuDriveListRepliesResponse
              >({
                client,
                method: "GET",
                url:
                  url +
                  encodeQuery({
                    file_type: resolved.file_type,
                    page_size: normalizeCommentPageSize(resolved.page_size),
                    page_token: resolved.page_token,
                    user_id_type: "open_id",
                  }),
              }),
            );
            return jsonResult({
              has_more: response.data?.has_more ?? false,
              page_token: response.data?.page_token,
              ...(isReplies
                ? { replies: (response.data?.items ?? []).map(normalizeCommentReply) }
                : { comments: (response.data?.items ?? []).map(normalizeCommentCard) }),
            });
          }
          case "add_comment":
          case "reply_comment": {
            const resolved = resolveDriveCommentParams(p, ctx);
            try {
              return jsonResult(
                await (resolved.action === "add_comment"
                  ? addComment(client, resolved)
                  : deliverCommentThreadText(client, resolved)),
              );
            } finally {
              // Typing cleanup must not delay the visible write result.
              void cleanupAmbientCommentTypingReaction({
                client,
                deliveryContext: ctx.deliveryContext,
              });
            }
          }
          default:
            return unknownToolActionResult((p as { action?: unknown }).action);
        }
      };
    },
  });
}
