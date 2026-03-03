import { Type, type Static } from "@sinclair/typebox";

const FileType = Type.Union([
  Type.Literal("doc"),
  Type.Literal("docx"),
  Type.Literal("sheet"),
  Type.Literal("bitable"),
]);

export const FeishuDocCommentSchema = Type.Union([
  Type.Object({
    action: Type.Literal("list_comments"),
    file_token: Type.String({ description: "Document file token" }),
    file_type: FileType,
  }),
  Type.Object({
    action: Type.Literal("get_comment"),
    file_token: Type.String({ description: "Document file token" }),
    file_type: FileType,
    comment_id: Type.String({ description: "Comment ID" }),
  }),
  Type.Object({
    action: Type.Literal("reply_comment"),
    file_token: Type.String({ description: "Document file token" }),
    file_type: FileType,
    comment_id: Type.String({ description: "Comment ID to reply to" }),
    content: Type.String({ description: "Reply content" }),
  }),
  Type.Object({
    action: Type.Literal("create_comment"),
    file_token: Type.String({ description: "Document file token" }),
    file_type: FileType,
    content: Type.String({ description: "Comment content" }),
  }),
]);

export type FeishuDocCommentParams = Static<typeof FeishuDocCommentSchema>;
