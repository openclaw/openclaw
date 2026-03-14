import { Type, type Static } from "@sinclair/typebox";

const SHEET_ACTION_VALUES = ["read_range", "get_sheets", "get_meta"] as const;

export const FeishuSheetSchema = Type.Object({
  action: Type.Unsafe<(typeof SHEET_ACTION_VALUES)[number]>({
    type: "string",
    enum: [...SHEET_ACTION_VALUES],
    description: "Action to run: read_range | get_sheets | get_meta",
  }),
  spreadsheet_token: Type.String({
    description: "Spreadsheet token (extract from URL /sheets/XXX or /wiki/XXX)",
  }),
  sheet_id: Type.Optional(
    Type.String({ description: "Sheet/tab ID (required for read_range)" }),
  ),
  range: Type.Optional(
    Type.String({ description: "Cell range to read, e.g. 'A1:C10' (required for read_range)" }),
  ),
});

export type FeishuSheetParams = Static<typeof FeishuSheetSchema>;
