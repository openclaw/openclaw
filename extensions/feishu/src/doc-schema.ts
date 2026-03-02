import { Type, type Static } from "@sinclair/typebox";
import { stringEnum } from "./schema-utils.js";

const DOC_ACTIONS = [
  "read",
  "write",
  "append",
  "create",
  "create_with_content",
  "list_blocks",
  "get_block",
  "update_block",
  "delete_block",
] as const;

export type FeishuDocAction = (typeof DOC_ACTIONS)[number];

export const FeishuDocSchema = Type.Object({
  action: stringEnum(DOC_ACTIONS, {
    description:
      "Action to perform: read/write/append/create/create_with_content/list_blocks/get_block/update_block/delete_block",
  }),
  doc_token: Type.Optional(
    Type.String({
      description:
        "Document token (required for read/write/append/list_blocks/get_block/update_block/delete_block; extract from URL /docx/XXX)",
    }),
  ),
  content: Type.Optional(
    Type.String({
      description: "Markdown content (required for write/append/update_block/create_with_content)",
    }),
  ),
  title: Type.Optional(
    Type.String({
      description: "Document title (required for create/create_with_content)",
    }),
  ),
  folder_token: Type.Optional(
    Type.String({ description: "Target folder token (optional for create/create_with_content)" }),
  ),
  block_id: Type.Optional(
    Type.String({
      description: "Block ID (required for get_block/update_block/delete_block)",
    }),
  ),
});

export type FeishuDocParams = Static<typeof FeishuDocSchema>;
