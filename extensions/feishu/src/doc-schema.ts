import { Type, type Static } from "@sinclair/typebox";

export const FeishuDocSchema = Type.Union([
  Type.Object({
    action: Type.Literal("read"),
    doc_token: Type.String({ description: "Document token (extract from URL /docx/XXX)" }),
  }),
  Type.Object({
    action: Type.Literal("write"),
    doc_token: Type.String({ description: "Document token" }),
    content: Type.String({
      description: "Markdown content to write (replaces entire document content)",
    }),
  }),
  Type.Object({
    action: Type.Literal("append"),
    doc_token: Type.String({ description: "Document token" }),
    content: Type.String({ description: "Markdown content to append to end of document" }),
  }),
  Type.Object({
    action: Type.Literal("create"),
    title: Type.String({ description: "Document title" }),
    folder_token: Type.Optional(Type.String({ description: "Target folder token (optional)" })),
    owner_open_id: Type.Optional(
      Type.String({ description: "Open ID of the user to grant ownership permission" }),
    ),
    owner_perm_type: Type.Optional(
      Type.Union([Type.Literal("view"), Type.Literal("edit"), Type.Literal("full_access")], {
        description: "Permission type (default: full_access)",
      }),
    ),
  }),
  Type.Object({
    action: Type.Literal("list_blocks"),
    doc_token: Type.String({ description: "Document token" }),
  }),
  Type.Object({
    action: Type.Literal("get_block"),
    doc_token: Type.String({ description: "Document token" }),
    block_id: Type.String({ description: "Block ID (from list_blocks)" }),
  }),
  Type.Object({
    action: Type.Literal("update_block"),
    doc_token: Type.String({ description: "Document token" }),
    block_id: Type.String({ description: "Block ID (from list_blocks)" }),
    content: Type.String({ description: "New text content" }),
  }),
  Type.Object({
    action: Type.Literal("delete_block"),
    doc_token: Type.String({ description: "Document token" }),
    block_id: Type.String({ description: "Block ID" }),
  }),
  Type.Object({
    action: Type.Literal("create_table"),
    doc_token: Type.String({ description: "Document token" }),
    parent_block_id: Type.Optional(
      Type.String({ description: "Parent block ID (default: document root)" }),
    ),
    row_size: Type.Integer({ description: "Table row count", minimum: 1 }),
    column_size: Type.Integer({ description: "Table column count", minimum: 1 }),
    column_width: Type.Optional(
      Type.Array(Type.Number({ minimum: 1 }), {
        description: "Column widths in px (length should match column_size)",
      }),
    ),
  }),
  Type.Object({
    action: Type.Literal("write_table_cells"),
    doc_token: Type.String({ description: "Document token" }),
    table_block_id: Type.String({ description: "Table block ID" }),
    values: Type.Array(Type.Array(Type.String()), {
      description: "2D matrix values[row][col] to write into table cells",
      minItems: 1,
    }),
  }),
  Type.Object({
    action: Type.Literal("create_table_with_values"),
    doc_token: Type.String({ description: "Document token" }),
    parent_block_id: Type.Optional(
      Type.String({ description: "Parent block ID (default: document root)" }),
    ),
    row_size: Type.Integer({ description: "Table row count", minimum: 1 }),
    column_size: Type.Integer({ description: "Table column count", minimum: 1 }),
    column_width: Type.Optional(
      Type.Array(Type.Number({ minimum: 1 }), {
        description: "Column widths in px (length should match column_size)",
      }),
    ),
    values: Type.Array(Type.Array(Type.String()), {
      description: "2D matrix values[row][col] to write into table cells",
      minItems: 1,
    }),
  }),
  Type.Object({
    action: Type.Literal("upload_image"),
    doc_token: Type.String({ description: "Document token" }),
    url: Type.Optional(Type.String({ description: "Remote image URL (http/https)" })),
    file_path: Type.Optional(Type.String({ description: "Local image file path" })),
    parent_block_id: Type.Optional(
      Type.String({ description: "Parent block ID (default: document root)" }),
    ),
    filename: Type.Optional(Type.String({ description: "Optional filename override" })),
    index: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Insert position (0-based index among siblings). Omit to append.",
      }),
    ),
  }),
  Type.Object({
    action: Type.Literal("upload_file"),
    doc_token: Type.String({ description: "Document token" }),
    url: Type.Optional(Type.String({ description: "Remote file URL (http/https)" })),
    file_path: Type.Optional(Type.String({ description: "Local file path" })),
    parent_block_id: Type.Optional(
      Type.String({ description: "Parent block ID (default: document root)" }),
    ),
    filename: Type.Optional(Type.String({ description: "Optional filename override" })),
  }),
]);

export type FeishuDocParams = Static<typeof FeishuDocSchema>;
