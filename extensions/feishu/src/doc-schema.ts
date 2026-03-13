import { Type, type Static } from "@sinclair/typebox";

const FEISHU_DOC_ACTION_VALUES = [
  "read",
  "write",
  "append",
  "insert",
  "create",
  "list_blocks",
  "get_block",
  "update_block",
  "delete_block",
  "create_table",
  "write_table_cells",
  "create_table_with_values",
  "insert_table_row",
  "insert_table_column",
  "delete_table_rows",
  "delete_table_columns",
  "merge_table_cells",
  "upload_image",
  "upload_file",
  "color_text",
] as const;

const tableCreationProperties = {
  parent_block_id: Type.Optional(
    Type.String({ description: "Parent block ID (default: document root)" }),
  ),
  row_size: Type.Optional(Type.Integer({ description: "Table row count", minimum: 1 })),
  column_size: Type.Optional(Type.Integer({ description: "Table column count", minimum: 1 })),
  column_width: Type.Optional(
    Type.Array(Type.Number({ minimum: 1 }), {
      description: "Column widths in px (length should match column_size)",
    }),
  ),
};

export const FeishuDocSchema = Type.Object(
  {
    action: Type.Unsafe<(typeof FEISHU_DOC_ACTION_VALUES)[number]>({
      type: "string",
      enum: [...FEISHU_DOC_ACTION_VALUES],
      description:
        "Document action to run: read, write, append, insert, create, list_blocks, get_block, update_block, delete_block, create_table, write_table_cells, create_table_with_values, insert_table_row, insert_table_column, delete_table_rows, delete_table_columns, merge_table_cells, upload_image, upload_file, color_text",
    }),
    doc_token: Type.Optional(
      Type.String({
        description:
          "Document token. Required for all actions except create. Extract from URL /docx/XXX.",
      }),
    ),
    content: Type.Optional(
      Type.String({
        description:
          "Markdown or text payload. Required for write, append, insert, update_block, and color_text.",
      }),
    ),
    after_block_id: Type.Optional(
      Type.String({
        description: "Required for insert. Insert content after this block ID.",
      }),
    ),
    title: Type.Optional(
      Type.String({
        description: "Required for create and rename-style content creation flows.",
      }),
    ),
    folder_token: Type.Optional(Type.String({ description: "Optional target folder for create." })),
    grant_to_requester: Type.Optional(
      Type.Boolean({
        description:
          "For create, grant edit permission to the trusted requesting Feishu user from runtime context.",
      }),
    ),
    block_id: Type.Optional(
      Type.String({
        description:
          "Block ID. Required for get_block, update_block, delete_block, table row/column operations, merge_table_cells, and color_text.",
      }),
    ),
    ...tableCreationProperties,
    table_block_id: Type.Optional(
      Type.String({ description: "Table block ID. Required for write_table_cells." }),
    ),
    values: Type.Optional(
      Type.Array(Type.Array(Type.String()), {
        description:
          "2D matrix values[row][col]. Required for write_table_cells and create_table_with_values.",
        minItems: 1,
      }),
    ),
    row_index: Type.Optional(
      Type.Number({ description: "Optional row index for insert_table_row (-1 for end)." }),
    ),
    column_index: Type.Optional(
      Type.Number({
        description: "Optional column index for insert_table_column (-1 for end).",
      }),
    ),
    row_start: Type.Optional(
      Type.Number({ description: "Start row index. Required for delete/merge row actions." }),
    ),
    row_count: Type.Optional(Type.Number({ description: "Rows to delete (default: 1)." })),
    row_end: Type.Optional(
      Type.Number({ description: "End row index (exclusive). Required for merge_table_cells." }),
    ),
    column_start: Type.Optional(
      Type.Number({ description: "Start column index. Required for delete/merge column actions." }),
    ),
    column_count: Type.Optional(Type.Number({ description: "Columns to delete (default: 1)." })),
    column_end: Type.Optional(
      Type.Number({
        description: "End column index (exclusive). Required for merge_table_cells.",
      }),
    ),
    url: Type.Optional(Type.String({ description: "Remote file/image URL for upload actions." })),
    file_path: Type.Optional(
      Type.String({ description: "Local file path for upload_image or upload_file." }),
    ),
    image: Type.Optional(
      Type.String({
        description:
          "Image as data URI or base64 string for upload_image when no URL/file_path is used.",
      }),
    ),
    filename: Type.Optional(Type.String({ description: "Optional upload filename override." })),
    index: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Optional insert position among siblings for upload_image.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type FeishuDocParams = Static<typeof FeishuDocSchema>;
