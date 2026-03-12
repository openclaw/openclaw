import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { FeishuSheetsSchema, type FeishuSheetsParams } from "./sheets-schema.js";
import { resolveToolsConfig } from "./tools-config.js";

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

async function getMeta(client: Lark.Client, params: FeishuSheetsParams) {
  // The Lark SDK sheets.spreadsheet.get retrieves spreadsheet metadata
  const res = await client.sheets.spreadsheet.get({
    path: { spreadsheet_token: params.spreadsheet_token },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    title: res.data?.spreadsheet?.title,
    spreadsheet_token: res.data?.spreadsheet?.token,
    url: res.data?.spreadsheet?.url,
  };
}

async function listSheets(client: Lark.Client, params: FeishuSheetsParams) {
  // Use spreadsheetSheet.query to get all sheet tabs in the spreadsheet.
  // The Lark SDK type definitions may not expose this method fully, so we cast to any.
  const res = await (client as any).sheets.spreadsheetSheet.query({
    path: { spreadsheet_token: params.spreadsheet_token },
  });

  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const sheets = res.data?.sheets ?? [];
  return {
    spreadsheet_token: params.spreadsheet_token,
    sheets: sheets.map((sheet: any) => ({
      sheet_id: sheet.sheet_id,
      title: sheet.title,
      index: sheet.index,
      row_count: sheet.grid_properties?.row_count,
      column_count: sheet.grid_properties?.column_count,
    })),
  };
}

async function readRange(client: Lark.Client, params: FeishuSheetsParams) {
  if (!params.sheet_id) {
    throw new Error("sheet_id is required for read_range");
  }

  const range = params.range ? `${params.sheet_id}!${params.range}` : params.sheet_id;

  // The Lark SDK type definitions don't fully expose the sheets v2 values API,
  // so we cast to any. We try client.request() first (raw HTTP), then fall back
  // to the SDK's internal path for reading spreadsheet values.
  let valuesRes: any;
  try {
    valuesRes = await (client as any).request({
      method: "GET",
      url: `/open-apis/sheets/v2/spreadsheets/${params.spreadsheet_token}/values/${encodeURIComponent(range)}`,
      params: { valueRenderOption: "ToString" },
    });
  } catch {
    // Fallback: try the SDK path if .request() is not available
    valuesRes = await (client as any).sheets.spreadsheet.values.get({
      path: { spreadsheet_token: params.spreadsheet_token },
      params: { range },
    });
  }

  // The v2 API returns data under data.valueRange
  const valueRange = valuesRes?.data?.valueRange ?? valuesRes?.data;
  const values: unknown[][] = valueRange?.values ?? [];

  // Apply page_size limit (default 100)
  const maxRows = params.page_size ?? 100;
  const limitedValues = values.slice(0, maxRows);

  return {
    spreadsheet_token: params.spreadsheet_token,
    sheet_id: params.sheet_id,
    range: valueRange?.range ?? range,
    total_rows: values.length,
    returned_rows: limitedValues.length,
    values: limitedValues,
  };
}

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

  const firstAccount = accounts[0];
  const toolsCfg = resolveToolsConfig(firstAccount.config.tools);
  if (!toolsCfg.sheets) {
    api.logger.debug?.("feishu_sheets: sheets tool disabled in config");
    return;
  }

  const getClient = () => createFeishuClient(firstAccount);

  api.registerTool(
    {
      name: "feishu_sheets",
      label: "Feishu Sheets",
      description:
        "Read Feishu spreadsheet (电子表格) data. Actions: get_meta, list_sheets, read_range",
      parameters: FeishuSheetsSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuSheetsParams;
        try {
          const client = getClient();
          switch (p.action) {
            case "get_meta":
              return json(await getMeta(client, p));
            case "list_sheets":
              return json(await listSheets(client, p));
            case "read_range":
              return json(await readRange(client, p));
            default:
              return json({ error: `Unknown action: ${String(p.action)}` });
          }
        } catch (err) {
          return json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    },
    { name: "feishu_sheets" },
  );

  api.logger.info?.("feishu_sheets: Registered feishu_sheets tool");
}
