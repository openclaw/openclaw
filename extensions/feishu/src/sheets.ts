import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuSheetsSchema, type FeishuSheetsParams } from "./sheets-schema.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";
import {
  jsonToolResult,
  toolExecutionErrorResult,
  unknownToolActionResult,
} from "./tool-result.js";

async function getMeta(client: Lark.Client, params: FeishuSheetsParams) {
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

  // The Lark SDK type definitions don't fully expose the sheets v2 values API.
  // Use client.request() (raw HTTP) if available, otherwise fall back to SDK path.
  let valuesRes: any;
  if (typeof (client as any).request === "function") {
    valuesRes = await (client as any).request({
      method: "GET",
      url: `/open-apis/sheets/v2/spreadsheets/${params.spreadsheet_token}/values/${encodeURIComponent(range)}`,
      params: { valueRenderOption: "ToString" },
    });
  } else {
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

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.sheets) {
    api.logger.debug?.("feishu_sheets: sheets tool disabled in config");
    return;
  }

  type FeishuSheetsExecuteParams = FeishuSheetsParams & { accountId?: string };

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: "feishu_sheets",
        label: "Feishu Sheets",
        description:
          "Read Feishu spreadsheet (电子表格) data. Actions: get_meta, list_sheets, read_range",
        parameters: FeishuSheetsSchema,
        async execute(_toolCallId, params) {
          const p = params as FeishuSheetsExecuteParams;
          try {
            const client = createFeishuToolClient({
              api,
              executeParams: p,
              defaultAccountId,
            });
            switch (p.action) {
              case "get_meta":
                return jsonToolResult(await getMeta(client, p));
              case "list_sheets":
                return jsonToolResult(await listSheets(client, p));
              case "read_range":
                return jsonToolResult(await readRange(client, p));
              default:
                return unknownToolActionResult((p as { action?: unknown }).action);
            }
          } catch (err) {
            return toolExecutionErrorResult(err);
          }
        },
      };
    },
    { name: "feishu_sheets" },
  );

  api.logger.info?.("feishu_sheets: Registered feishu_sheets tool");
}
