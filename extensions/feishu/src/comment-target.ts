// Feishu plugin module implements comment target behavior.
import { readStringOption } from "openclaw/plugin-sdk/string-coerce-runtime";

export const FEISHU_COMMENT_FILE_TYPES = ["doc", "docx", "file", "sheet", "slides"] as const;

export type CommentFileType = (typeof FEISHU_COMMENT_FILE_TYPES)[number];

export function normalizeCommentFileType(value: unknown): CommentFileType | undefined {
  return readStringOption(value, FEISHU_COMMENT_FILE_TYPES);
}

type FeishuCommentTarget = {
  fileType: CommentFileType;
  fileToken: string;
  commentId: string;
};

export function buildFeishuCommentTarget(params: FeishuCommentTarget): string {
  return `comment:${params.fileType}:${params.fileToken}:${params.commentId}`;
}

export function parseFeishuCommentTarget(
  raw: string | undefined | null,
): FeishuCommentTarget | null {
  const trimmed = raw?.trim();
  if (!trimmed?.startsWith("comment:")) {
    return null;
  }
  const parts = trimmed.split(":");
  if (parts.length !== 4) {
    return null;
  }
  const fileType = normalizeCommentFileType(parts[1]);
  const fileToken = parts[2]?.trim();
  const commentId = parts[3]?.trim();
  if (!fileType || !fileToken || !commentId) {
    return null;
  }
  return {
    fileType,
    fileToken,
    commentId,
  };
}
