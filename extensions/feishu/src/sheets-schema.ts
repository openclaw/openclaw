import { Type, type Static } from "@sinclair/typebox";

const SHEETS_ACTION_VALUES = ["get_meta", "read_range", "list_sheets"] as const;

export const FeishuSheetsSchema = Type.Object({
  action: Type.Unsafe<(typeof SHEETS_ACTION_VALUES)[number]>({
    type: "string",
    enum: [...SHEETS_ACTION_VALUES],
    description: "Action to run: get_meta | read_range | list_sheets",
  }),
  spreadsheet_token: Type.String({
    description:
      "Spreadsheet token (the part after /sheets/ in the URL, e.g. from https://xxx.feishu.cn/sheets/{token})",
  }),
  sheet_id: Type.Optional(
    Type.String({
      description: "Sheet tab ID (required for read_range — identifies which sheet tab to read)",
    }),
  ),
  range: Type.Optional(
    Type.String({
      description:
        'Cell range in A1 notation, e.g. "A1:Z100". If omitted, reads all data in the sheet.',
    }),
  ),
  page_size: Type.Optional(
    Type.Number({
      description: "Max rows to return (default 100). Used to limit read_range results.",
    }),
  ),
});

export type FeishuSheetsParams = Static<typeof FeishuSheetsSchema>;
