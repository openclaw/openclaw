import type * as Lark from "@larksuiteoapi/node-sdk";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";

// ============ Helpers =========

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

const ROW_FALLBACK_COUNT = 1000;
const COLUMN_FALLBACK_COUNT = 26;
const MAX_HINT_CHUNK_ROWS = 200;

/**
 * Error payload format used by Feishu Sheets tool.
 */
class FeishuSheetsError extends Error {
  constructor(
    public code: "invalid_range" | "sheet_meta_error" | "read_error" | "unknown",
    message: string,
    public details?: unknown,
    public nextRangeHint?: string,
  ) {
    super(message);
    this.name = "FeishuSheetsError";
  }

  toPayload() {
    return {
      error: this.message,
      code: this.code,
      ...(this.nextRangeHint ? { next_range_hint: this.nextRangeHint } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

type RangeBounds = {
  startColumnIndex: number;
  endColumnIndex: number;
  startRowIndex: number;
  endRowIndex: number;
};

type SheetMeta = {
  title?: string;
  row_count?: number;
  column_count?: number;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function cellToIndex(cell: string): [number, number] {
  const match = /^([A-Za-z]+)(\d+)$/.exec(cell);
  if (!match?.[1] || !match?.[2]) {
    throw new FeishuSheetsError(
      "invalid_range",
      `Invalid A1 range cell: ${cell}. Expected values like A1, B2, AA12.`,
    );
  }

  let columnIndex = 0;
  for (const ch of match[1].toUpperCase()) {
    const ord = ch.charCodeAt(0) - 64;
    if (ord < 1 || ord > 26) {
      throw new FeishuSheetsError("invalid_range", `Invalid column label: ${cell}`);
    }
    columnIndex = columnIndex * 26 + ord;
  }

  const rowIndex = Number.parseInt(match[2], 10);
  if (!Number.isInteger(rowIndex) || rowIndex <= 0) {
    throw new FeishuSheetsError("invalid_range", `Invalid row index: ${cell}`);
  }

  return [columnIndex, rowIndex];
}

function parseRange(range: string): RangeBounds {
  const trimmed = range.trim();
  const parts = trimmed.split(":");
  if (parts.length > 2) {
    throw new FeishuSheetsError(
      "invalid_range",
      `Invalid range format: ${range}. Expected A1 or A1:C5.`,
    );
  }
  const startRaw = parts[0]?.trim();
  const endRaw = parts[1]?.trim();

  if (parts.length === 2 && endRaw === "") {
    throw new FeishuSheetsError(
      "invalid_range",
      `Invalid range format: ${range}. Expected A1 or A1:C5.`,
    );
  }

  if (!startRaw || startRaw.includes(":")) {
    throw new FeishuSheetsError(
      "invalid_range",
      `Invalid range format: ${range}. Expected A1 or A1:C5.`,
    );
  }

  const [startCol, startRow] = cellToIndex(startRaw);
  const [endColRaw, endRowRaw] = endRaw ? cellToIndex(endRaw) : [startCol, startRow];
  if (endColRaw < startCol || endRowRaw < startRow) {
    throw new FeishuSheetsError(
      "invalid_range",
      `Invalid range format: ${range}. End cannot be before start.`,
    );
  }

  return {
    startColumnIndex: startCol,
    endColumnIndex: endColRaw,
    startRowIndex: startRow,
    endRowIndex: endRowRaw,
  };
}

function colToLabel(index: number): string {
  let value = index;
  let result = "";
  while (value > 0) {
    const rem = (value - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result || "A";
}

function rangeToA1(range: RangeBounds): string {
  return `${colToLabel(range.startColumnIndex)}${range.startRowIndex}:${colToLabel(range.endColumnIndex)}${range.endRowIndex}`;
}

function detectSheetMeta(raw: unknown): SheetMeta {
  const root = asRecord(raw) ?? {};
  const candidate =
    asRecord(root.sheet) ?? asRecord(root.data) ?? asRecord(root.properties) ?? root;

  const grid = asRecord(candidate.grid_properties) ?? asRecord(candidate.gridProperties) ?? {};

  const title =
    typeof candidate.title === "string"
      ? candidate.title
      : typeof candidate.name === "string"
        ? candidate.name
        : undefined;

  const rowCountValue =
    typeof candidate.row_count === "number"
      ? candidate.row_count
      : typeof candidate.rowCount === "number"
        ? candidate.rowCount
        : typeof grid.row_count === "number"
          ? grid.row_count
          : typeof grid.rowCount === "number"
            ? grid.rowCount
            : undefined;

  const columnCountValue =
    typeof candidate.column_count === "number"
      ? candidate.column_count
      : typeof candidate.columnCount === "number"
        ? candidate.columnCount
        : typeof grid.column_count === "number"
          ? grid.column_count
          : typeof grid.columnCount === "number"
            ? grid.columnCount
            : undefined;

  return {
    title,
    row_count: rowCountValue,
    column_count: columnCountValue,
  };
}

function getRangeFromMeta(meta?: SheetMeta) {
  const endRow =
    typeof meta?.row_count === "number" && Number.isInteger(meta.row_count) && meta.row_count > 0
      ? meta.row_count
      : ROW_FALLBACK_COUNT;
  const rawColCount =
    typeof meta?.column_count === "number" &&
    Number.isInteger(meta.column_count) &&
    meta.column_count > 0
      ? meta.column_count
      : COLUMN_FALLBACK_COUNT;
  const endCol = Math.min(rawColCount, 18278);

  return {
    startColumnIndex: 1,
    startRowIndex: 1,
    endColumnIndex: endCol,
    endRowIndex: endRow,
  };
}

function safeNextRangeHint(
  current: RangeBounds,
  nextStartRow: number,
  columnEnd: number,
  rowLimit?: number,
) {
  if (nextStartRow <= 0 || columnEnd <= 0) {
    return undefined;
  }

  const chunk = current.endRowIndex - current.startRowIndex + 1;
  const defaultEnd = nextStartRow + Math.max(1, chunk) - 1;

  if (Number.isFinite(rowLimit ?? Infinity)) {
    const limit = typeof rowLimit === "number" && rowLimit > 0 ? rowLimit : undefined;
    const finalEnd = limit ? Math.min(limit, defaultEnd) : defaultEnd;
    if (nextStartRow > finalEnd) {
      return undefined;
    }
    return `${colToLabel(current.startColumnIndex)}${nextStartRow}:${colToLabel(columnEnd)}${finalEnd}`;
  }

  return `${colToLabel(current.startColumnIndex)}${nextStartRow}:${colToLabel(columnEnd)}${defaultEnd}`;
}

function parseValueRangeBounds(range: string): {
  rowCount: number;
  columnCount: number;
} {
  const parts = range.split(":");
  if (parts.length === 1 && parts[0]) {
    return { rowCount: 1, columnCount: 1 };
  }
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { rowCount: 0, columnCount: 0 };
  }

  const start = cellToIndex(parts[0]);
  const end = cellToIndex(parts[1]);
  return {
    rowCount: Math.max(1, end[1] - start[1] + 1),
    columnCount: Math.max(1, end[0] - start[0] + 1),
  };
}

function normalizeCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  if (typeof value === "string") {
    return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " <br> ");
  }
  return JSON.stringify(value);
}

function asMarkdownTable(values: unknown[][]): string {
  const normalizedRows = values.map((row) =>
    Array.isArray(row) ? row.map((cell) => normalizeCellValue(cell)) : [normalizeCellValue(row)],
  );
  const colCount =
    normalizedRows.length === 0
      ? 0
      : Math.max(...normalizedRows.map((row) => (Array.isArray(row) ? row.length : 0)));

  if (colCount === 0) {
    return "";
  }

  const paddedRows = normalizedRows.map((row) =>
    Array.from({ length: colCount }, (_, i) =>
      Array.isArray(row) && row[i] !== undefined ? row[i] : "",
    ),
  );

  const header = Array.from({ length: colCount }, (_, i) => `C${i + 1}`);
  const headerRow = `| ${header.join(" | ")} |`;
  const divider = `| ${header.map(() => "---").join(" | ")} |`;
  const body = paddedRows.map((row) => `| ${row.join(" | ")} |`).join("\n");

  return `${headerRow}\n${divider}\n${body}`;
}

async function fetchSheetsJson(
  client: Lark.Client,
  spreadsheetToken: string,
  sheetId: string,
  extraPath: string,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fallback path for versions without typed helper
  return (await (client as any).request({
    method: "GET",
    url: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets/${encodeURIComponent(sheetId)}${extraPath}`,
  })) as Record<string, unknown>;
}

async function getSheetMeta(
  client: Lark.Client,
  spreadsheetToken: string,
  sheetId: string,
): Promise<SheetMeta> {
  const response = await fetchSheetsJson(client, spreadsheetToken, sheetId, "");
  if (typeof response?.code !== "number" || response.code !== 0) {
    throw new FeishuSheetsError(
      "sheet_meta_error",
      `Failed to read sheet metadata. code=${String(response?.code ?? "unknown")}, msg=${String(response?.msg ?? "unknown")}`,
      response,
    );
  }

  return detectSheetMeta(response.data ?? response);
}

async function readValues(
  client: Lark.Client,
  spreadsheetToken: string,
  sheetId: string,
  resolvedRange: string,
) {
  const response = await fetchSheetsJson(
    client,
    spreadsheetToken,
    sheetId,
    `/values/${encodeURIComponent(resolvedRange)}`,
  );
  if (typeof response?.code !== "number" || response.code !== 0) {
    throw new FeishuSheetsError(
      "read_error",
      `Failed to read sheet values. code=${String(response?.code ?? "unknown")}, msg=${String(response?.msg ?? "unknown")}`,
      response,
    );
  }

  return response.data as Record<string, unknown>;
}

function normalizeValueRangeData(raw: Record<string, unknown> | undefined) {
  const valueRange =
    (asRecord(raw?.value_range) as Record<string, unknown> | undefined) ??
    (asRecord(raw?.valueRange) as Record<string, unknown> | undefined) ??
    asRecord(raw);

  const values = Array.isArray(valueRange?.values) ? (valueRange.values as unknown[][]) : [];
  const range =
    typeof valueRange?.range === "string"
      ? valueRange.range
      : typeof valueRange?.valueRange === "string"
        ? (valueRange.valueRange as string)
        : "";

  return {
    range,
    values,
    majorDimension:
      typeof valueRange?.majorDimension === "string"
        ? valueRange.majorDimension
        : typeof valueRange?.major_dimension === "string"
          ? valueRange.major_dimension
          : undefined,
    revision: typeof valueRange?.revision === "number" ? valueRange.revision : undefined,
  };
}

async function readSheetRange(params: {
  client: Lark.Client;
  spreadsheetToken: string;
  sheetId: string;
  requestedRange?: string;
  includeMarkdown?: boolean;
}) {
  const normalizedRequestedRange = params.requestedRange?.trim();
  const requestedRange =
    normalizedRequestedRange && normalizedRequestedRange.length > 0
      ? normalizedRequestedRange
      : undefined;
  const requestedBounds = requestedRange ? parseRange(requestedRange) : undefined;
  const sheetMeta = await getSheetMeta(params.client, params.spreadsheetToken, params.sheetId);
  const resolvedBounds = requestedBounds ?? getRangeFromMeta(sheetMeta);
  const requestedRowsBounds = requestedBounds ?? resolvedBounds;
  const resolvedRange = rangeToA1(resolvedBounds);
  const requestedRows = requestedRowsBounds.endRowIndex - requestedRowsBounds.startRowIndex + 1;
  const includeNextHint = requestedRange == null;

  let resolved = {
    spreadsheet_token: params.spreadsheetToken,
    sheet_id: params.sheetId,
    requested_range: requestedRange ?? null,
    resolved_range: resolvedRange,
  };

  try {
    const rawData = await readValues(
      params.client,
      params.spreadsheetToken,
      params.sheetId,
      resolvedRange,
    );
    const valueRange = normalizeValueRangeData(rawData);
    const valueRangeRange = valueRange.range || resolvedRange;
    const values = valueRange.values;
    const responseBounds = parseValueRangeBounds(valueRangeRange);

    const nextRangeHint =
      includeNextHint &&
      values.length >= Math.max(0, requestedRows) &&
      responseBounds.rowCount === requestedRows
        ? safeNextRangeHint(
            requestedRowsBounds,
            requestedRowsBounds.endRowIndex + 1,
            requestedRowsBounds.endColumnIndex,
            sheetMeta.row_count,
          )
        : undefined;

    return {
      ...resolved,
      values,
      value_range: {
        range: valueRangeRange,
        major_dimension: valueRange.majorDimension,
        revision: valueRange.revision,
        row_count: responseBounds.rowCount,
        column_count: responseBounds.columnCount,
      },
      sheet_meta: sheetMeta,
      ...(nextRangeHint ? { next_range_hint: nextRangeHint } : {}),
      ...(params.includeMarkdown ? { markdown: asMarkdownTable(values) } : {}),
    };
  } catch (err) {
    if (err instanceof FeishuSheetsError) {
      const shouldChunkHint = requestedRangeExceedsLimit(requestedRowsBounds, MAX_HINT_CHUNK_ROWS);
      const chunkEndRow = requestedRowsBounds.startRowIndex + MAX_HINT_CHUNK_ROWS - 1;
      const fallbackHint = shouldChunkHint
        ? safeNextRangeHint(
            requestedRowsBounds,
            requestedRowsBounds.startRowIndex,
            requestedRowsBounds.endColumnIndex,
            typeof sheetMeta.row_count === "number" && sheetMeta.row_count > 0
              ? Math.min(sheetMeta.row_count, chunkEndRow)
              : chunkEndRow,
          )
        : undefined;

      throw new FeishuSheetsError(
        err.code,
        err.message,
        err.details,
        shouldChunkHint ? fallbackHint : err.nextRangeHint,
      );
    }

    throw new FeishuSheetsError("unknown", `Unexpected sheet read failure: ${String(err)}`);
  }
}

function requestedRangeExceedsLimit(range: RangeBounds, chunkRows: number): boolean {
  const requestRows = range.endRowIndex - range.startRowIndex + 1;
  return requestRows > chunkRows;
}

const FeishuSheetsReadRangeSchema = Type.Object({
  spreadsheet_token: Type.String({
    description: "Spreadsheet token (from URL path or token)",
  }),
  sheet_id: Type.String({ description: "Sheet ID in the spreadsheet" }),
  range: Type.Optional(
    Type.String({
      description:
        "Optional A1 range, for example A1:C5. If omitted, infer from sheet metadata, fallback A1:Z1000.",
    }),
  ),
  include_markdown: Type.Optional(
    Type.Boolean({ description: "Include a markdown preview under markdown field" }),
  ),
});

type FeishuSheetsReadRangeParams = {
  spreadsheet_token: string;
  sheet_id: string;
  range?: string;
  include_markdown?: boolean;
  accountId?: string;
};

// ============ Tool Registration ============

export function registerFeishuSheetsTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_sheets: No config available, skipping sheets tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_sheets: No Feishu accounts configured, skipping sheets tools");
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.sheets) {
    api.logger.debug?.("feishu_sheets: sheets tool disabled in config");
    return;
  }

  const getClient = (params: { accountId?: string } | undefined, defaultAccountId?: string) =>
    createFeishuToolClient({ api, executeParams: params, defaultAccountId });

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: "feishu_sheets_read_range",
        label: "Feishu Sheets Read Range",
        description: "Read a spreadsheet range in A1 style from a sheet node.",
        parameters: FeishuSheetsReadRangeSchema,
        async execute(_toolCallId, rawParams) {
          const params = rawParams as FeishuSheetsReadRangeParams;
          try {
            const client = getClient(params, defaultAccountId);
            return json(
              await readSheetRange({
                client,
                spreadsheetToken: params.spreadsheet_token,
                sheetId: params.sheet_id,
                requestedRange: params.range,
                includeMarkdown: params.include_markdown,
              }),
            );
          } catch (err) {
            if (err instanceof FeishuSheetsError) {
              return json(err.toPayload());
            }
            return json({
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      };
    },
    { name: "feishu_sheets_read_range" },
  );

  api.logger.info?.("feishu_sheets: Registered feishu_sheets_read_range tool");
}
