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
    action: Type.Literal("insert"),
    doc_token: Type.String({ description: "Document token" }),
    content: Type.String({ description: "Markdown content to insert" }),
    after_block_id: Type.String({
      description: "Insert content after this block ID. Use list_blocks to find block IDs.",
    }),
  }),
  Type.Object({
    action: Type.Literal("create"),
    title: Type.String({ description: "Document title" }),
    folder_token: Type.Optional(Type.String({ description: "Target folder token (optional)" })),
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
  // Table operations
  Type.Object({
    action: Type.Literal("insert_table_row"),
    doc_token: Type.String({ description: "Document token" }),
    block_id: Type.String({ description: "Table block ID" }),
    row_index: Type.Optional(
      Type.Number({ description: "Row index to insert at (-1 for end, default: -1)" }),
    ),
  }),
  Type.Object({
    action: Type.Literal("insert_table_column"),
    doc_token: Type.String({ description: "Document token" }),
    block_id: Type.String({ description: "Table block ID" }),
    column_index: Type.Optional(
      Type.Number({ description: "Column index to insert at (-1 for end, default: -1)" }),
    ),
  }),
  Type.Object({
    action: Type.Literal("delete_table_rows"),
    doc_token: Type.String({ description: "Document token" }),
    block_id: Type.String({ description: "Table block ID" }),
    row_start: Type.Number({ description: "Start row index (0-based)" }),
    row_count: Type.Optional(Type.Number({ description: "Number of rows to delete (default: 1)" })),
  }),
  Type.Object({
    action: Type.Literal("delete_table_columns"),
    doc_token: Type.String({ description: "Document token" }),
    block_id: Type.String({ description: "Table block ID" }),
    column_start: Type.Number({ description: "Start column index (0-based)" }),
    column_count: Type.Optional(
      Type.Number({ description: "Number of columns to delete (default: 1)" }),
    ),
  }),
  Type.Object({
    action: Type.Literal("merge_table_cells"),
    doc_token: Type.String({ description: "Document token" }),
    block_id: Type.String({ description: "Table block ID" }),
    row_start: Type.Number({ description: "Start row index" }),
    row_end: Type.Number({ description: "End row index (exclusive)" }),
    column_start: Type.Number({ description: "Start column index" }),
    column_end: Type.Number({ description: "End column index (exclusive)" }),
  }),
  // Image upload
  Type.Object({
    action: Type.Literal("upload_image"),
    doc_token: Type.String({ description: "Document token" }),
    image: Type.String({
      description:
        "Image source: https/http URL, data URI (data:image/png;base64,...), plain base64 string, or absolute file path",
    }),
    file_name: Type.Optional(Type.String({ description: "File name (e.g. chart.png)" })),
    block_id: Type.Optional(
      Type.String({ description: "Insert after this block ID (default: append to document end)" }),
    ),
  }),
  // Color text
  Type.Object({
    action: Type.Literal("color_text"),
    doc_token: Type.String({ description: "Document token" }),
    block_id: Type.String({ description: "Text block ID to update" }),
    content: Type.String({
      description:
        'Text with color markup. Supported tags: [red], [green], [blue], [orange], [yellow], [purple], [grey], [bold], [bg:yellow]. Example: "Revenue [green]+15%[/green] YoY, Costs [red]-3%[/red]"',
    }),
  }),
]);

export type FeishuDocParams = Static<typeof FeishuDocSchema>;
