import type * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuSheetSchema, type FeishuSheetParams } from "./sheet-schema.js";
import { createFeishuToolClient } from "./tool-account.js";
import { resolveToolsConfig } from "./tools-config.js";

// ============ Helpers ============

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ============ Core Functions ============

/** Read cell values from a range */
async function readRange(
  client: Lark.Client,
  spreadsheetToken: string,
  sheetId: string,
  range: string,
) {
  const fullRange = `${sheetId}!${range}`;
  const res = (await client.request({
    method: "GET",
    url: `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${fullRange}`,
  })) as {
    code?: number;
    msg?: string;
    data?: {
      revision?: number;
      spreadsheetToken?: string;
      valueRange?: {
        majorDimension?: string;
        range?: string;
        revision?: number;
        values?: unknown[][];
      };
    };
  };

  if (res.code !== 0) {
    throw new Error(res.msg ?? `Failed to read range: code=${res.code}`);
  }

  return {
    range: fullRange,
    values: res.data?.valueRange?.values ?? [],
    revision: res.data?.valueRange?.revision,
  };
}

/** List all sheets/tabs in a spreadsheet */
async function getSheets(client: Lark.Client, spreadsheetToken: string) {
  const res = (await client.request({
    method: "GET",
    url: `/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`,
  })) as {
    code?: number;
    msg?: string;
    data?: {
      sheets?: Array<{
        sheet_id?: string;
        title?: string;
        index?: number;
        hidden?: boolean;
        grid_properties?: {
          frozen_row_count?: number;
          frozen_column_count?: number;
          row_count?: number;
          column_count?: number;
        };
      }>;
    };
  };

  if (res.code !== 0) {
    throw new Error(res.msg ?? `Failed to list sheets: code=${res.code}`);
  }

  return {
    sheets:
      res.data?.sheets?.map((s) => ({
        sheet_id: s.sheet_id,
        title: s.title,
        index: s.index,
        hidden: s.hidden,
        row_count: s.grid_properties?.row_count,
        column_count: s.grid_properties?.column_count,
      })) ?? [],
  };
}

/** Get spreadsheet metadata */
async function getMeta(client: Lark.Client, spreadsheetToken: string) {
  const res = (await client.request({
    method: "GET",
    url: `/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}`,
  })) as {
    code?: number;
    msg?: string;
    data?: {
      spreadsheet?: {
        title?: string;
        owner_id?: string;
        token?: string;
        url?: string;
      };
    };
  };

  if (res.code !== 0) {
    throw new Error(res.msg ?? `Failed to get metadata: code=${res.code}`);
  }

  return {
    title: res.data?.spreadsheet?.title,
    owner_id: res.data?.spreadsheet?.owner_id,
    token: res.data?.spreadsheet?.token,
    url: res.data?.spreadsheet?.url,
  };
}

// ============ Tool Registration ============

export function registerFeishuSheetTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_sheet: No config available, skipping sheet tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_sheet: No Feishu accounts configured, skipping sheet tools");
    return;
  }

  const firstAccount = accounts[0];
  const toolsCfg = resolveToolsConfig(firstAccount.config.tools);
  if (!toolsCfg.sheet) {
    api.logger.debug?.("feishu_sheet: sheet tool disabled in config");
    return;
  }

  type AccountAwareParams = { accountId?: string };

  const getClient = (params: AccountAwareParams | undefined, defaultAccountId?: string) =>
    createFeishuToolClient({ api, executeParams: params, defaultAccountId });

  api.registerTool(
    (ctx) => ({
      name: "feishu_sheet",
      label: "Feishu Sheet",
      description:
        "Feishu spreadsheet operations. Actions: read_range (read cells), get_sheets (list tabs), get_meta (spreadsheet info)",
      parameters: FeishuSheetSchema,
      async execute(_toolCallId, params) {
        const p = params as FeishuSheetParams & AccountAwareParams;
        try {
          const client = getClient(p, ctx.agentAccountId);
          switch (p.action) {
            case "read_range": {
              if (!p.sheet_id) {
                return json({ error: "sheet_id is required for read_range action" });
              }
              if (!p.range) {
                return json({ error: "range is required for read_range action" });
              }
              return json(
                await readRange(client, p.spreadsheet_token, p.sheet_id, p.range),
              );
            }
            case "get_sheets":
              return json(await getSheets(client, p.spreadsheet_token));
            case "get_meta":
              return json(await getMeta(client, p.spreadsheet_token));
            default:
              return json({ error: `Unknown action: ${String(p.action)}` });
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    }),
    { name: "feishu_sheet" },
  );

  api.logger.info?.("feishu_sheet: Registered feishu_sheet tool");
}
