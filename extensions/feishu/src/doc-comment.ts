/**
 * Feishu Document Comment Operations
 *
 * Handles document comment detection and reply functionality.
 * When a user @mentions the bot in a document comment, the bot can detect this
 * and reply to the comment directly.
 */

import type * as Lark from "@larksuiteoapi/node-sdk";

// ============ Types ============

export type DocFileType = "doc" | "docx" | "sheet" | "bitable";

export interface DocCommentInfo {
  fileToken: string;
  fileType: DocFileType;
  commentId?: string;
  replyId?: string;
}

export interface CommentReply {
  reply_id: string;
  content: string;
  create_time: number;
  update_time: number;
}

export interface Comment {
  comment_id: string;
  user_id: string;
  create_time: number;
  update_time: number;
  is_solved: boolean;
  quote: string;
  replies: CommentReply[];
}

// ============ HTTP Helper ============

interface FeishuApiResponse<T> {
  code: number;
  msg?: string;
  data?: T;
}

async function feishuHttpRequest<T>(
  client: Lark.Client,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  params?: Record<string, string>,
  data?: unknown,
): Promise<FeishuApiResponse<T>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing internal SDK property
  const domain = (client as any).domain ?? "https://open.feishu.cn";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing internal SDK property
  const httpInstance = (client as any).httpInstance;

  let url = `${domain}${path}`;
  if (params && Object.keys(params).length > 0) {
    const query = new URLSearchParams(params).toString();
    url = `${url}?${query}`;
  }

  let res: FeishuApiResponse<T>;
  if (method === "GET") {
    res = await httpInstance.get(url);
  } else if (method === "POST") {
    res = await httpInstance.post(url, data);
  } else if (method === "PUT") {
    res = await httpInstance.put(url, data);
  } else if (method === "DELETE") {
    res = await httpInstance.delete(url);
  } else {
    throw new Error(`Unsupported method: ${method}`);
  }

  return res;
}

// ============ URL Parsing ============

/**
 * Extract document info from a Feishu document URL.
 *
 * Supported URL formats:
 * - https://xxx.feishu.cn/docx/ABC123
 * - https://xxx.feishu.cn/docs/ABC123
 * - https://xxx.feishu.cn/sheets/ABC123
 * - https://xxx.feishu.cn/base/ABC123
 * - With comment anchor: ...#comment-XYZ
 */
export function parseDocUrl(url: string): DocCommentInfo | null {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;

    // Match /docx/, /docs/, /sheets/, /base/ patterns
    const docxMatch = pathname.match(/\/docx\/([A-Za-z0-9]+)/);
    const docsMatch = pathname.match(/\/docs\/([A-Za-z0-9]+)/);
    const sheetsMatch = pathname.match(/\/sheets\/([A-Za-z0-9]+)/);
    const baseMatch = pathname.match(/\/base\/([A-Za-z0-9]+)/);

    let fileToken: string | undefined;
    let fileType: "doc" | "docx" | "sheet" | "bitable" | undefined;

    if (docxMatch) {
      fileToken = docxMatch[1];
      fileType = "docx";
    } else if (docsMatch) {
      fileToken = docsMatch[1];
      fileType = "doc";
    } else if (sheetsMatch) {
      fileToken = sheetsMatch[1];
      fileType = "sheet";
    } else if (baseMatch) {
      fileToken = baseMatch[1];
      fileType = "bitable";
    }

    if (!fileToken || !fileType) {
      return null;
    }

    // Extract comment ID from hash if present
    // Format: #comment-ABC123 or #comment-ABC123-reply-XYZ
    const hash = parsed.hash;
    let commentId: string | undefined;
    let replyId: string | undefined;

    if (hash) {
      const commentMatch = hash.match(/comment-([A-Za-z0-9]+)/);
      if (commentMatch) {
        commentId = commentMatch[1];
      }
      const replyMatch = hash.match(/reply-([A-Za-z0-9]+)/);
      if (replyMatch) {
        replyId = replyMatch[1];
      }
    }

    return {
      fileToken,
      fileType,
      commentId,
      replyId,
    };
  } catch {
    return null;
  }
}

/**
 * Extract document URLs from message text.
 */
export function extractDocUrls(text: string): DocCommentInfo[] {
  // Support both feishu.cn and larksuite.com domains
  const urlPattern =
    /https?:\/\/[^\s<>"{}|\\^`[\]]+\.(?:feishu\.cn|larksuite\.com)\/(?:docx|docs|sheets|base)\/[A-Za-z0-9]+[^\s<>"{}|\\^`[\]]*/gi;
  const matches = text.match(urlPattern) || [];
  const results: DocCommentInfo[] = [];

  for (const url of matches) {
    const info = parseDocUrl(url);
    if (info) {
      results.push(info);
    }
  }

  return results;
}

// ============ Comment API ============

/**
 * List comments on a document.
 *
 * API: GET /open-apis/drive/v1/files/:file_token/comments
 */
export async function listDocComments(
  client: Lark.Client,
  fileToken: string,
  fileType: DocFileType,
): Promise<Comment[]> {
  const res = await feishuHttpRequest<{ items?: Comment[] }>(
    client,
    "GET",
    `/open-apis/drive/v1/files/${fileToken}/comments`,
    { file_type: fileType },
  );

  if (res.code !== 0) {
    throw new Error(`Failed to list comments: ${res.msg}`);
  }

  return res.data?.items || [];
}

/**
 * Get a specific comment by ID.
 *
 * API: GET /open-apis/drive/v1/files/:file_token/comments/:comment_id
 */
export async function getDocComment(
  client: Lark.Client,
  fileToken: string,
  fileType: DocFileType,
  commentId: string,
): Promise<Comment | null> {
  const res = await feishuHttpRequest<Comment>(
    client,
    "GET",
    `/open-apis/drive/v1/files/${fileToken}/comments/${commentId}`,
    { file_type: fileType },
  );

  if (res.code !== 0) {
    if (res.code === 1300002) {
      // Comment not found
      return null;
    }
    throw new Error(`Failed to get comment: ${res.msg}`);
  }

  return res.data || null;
}

/**
 * Reply to a document comment.
 *
 * API: POST /open-apis/drive/v1/files/:file_token/comments/:comment_id/replies
 */
export async function replyToDocComment(
  client: Lark.Client,
  fileToken: string,
  fileType: DocFileType,
  commentId: string,
  content: string,
): Promise<CommentReply> {
  const res = await feishuHttpRequest<CommentReply>(
    client,
    "POST",
    `/open-apis/drive/v1/files/${fileToken}/comments/${commentId}/replies`,
    { file_type: fileType },
    {
      content: {
        elements: [
          {
            type: "text_run",
            text_run: {
              text: content,
            },
          },
        ],
      },
    },
  );

  if (res.code !== 0) {
    throw new Error(`Failed to reply to comment: ${res.msg}`);
  }

  if (!res.data) {
    throw new Error("No reply data returned");
  }

  return res.data;
}

/**
 * Create a new comment on a document (not a reply).
 * Note: Creating comments requires specifying a quote (text range to attach the comment to).
 *
 * API: POST /open-apis/drive/v1/files/:file_token/comments
 */
export async function createDocComment(
  client: Lark.Client,
  fileToken: string,
  fileType: DocFileType,
  content: string,
): Promise<Comment> {
  const res = await feishuHttpRequest<Comment>(
    client,
    "POST",
    `/open-apis/drive/v1/files/${fileToken}/comments`,
    { file_type: fileType },
    {
      content: {
        elements: [
          {
            type: "text_run",
            text_run: {
              text: content,
            },
          },
        ],
      },
    },
  );

  if (res.code !== 0) {
    throw new Error(`Failed to create comment: ${res.msg}`);
  }

  if (!res.data) {
    throw new Error("No comment data returned");
  }

  return res.data;
}
