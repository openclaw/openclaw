// Feishu tests cover bitable plugin behavior.
import type * as Lark from "@larksuiteoapi/node-sdk";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

import { registerFeishuBitableTools } from "./bitable.js";

type MockRecord = {
  record_id?: string;
  fields?: Record<string, unknown>;
};

function createConfig(): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          default: {
            appId: "cli_default",
            appSecret: "secret_default", // pragma: allowlist secret
          },
        },
      },
    },
  } as OpenClawPluginApi["config"];
}

function createBitableClient(records: MockRecord[]) {
  const batchDelete = vi.fn(async () => ({ code: 0 }));
  const appTableList = vi.fn(async () => ({
    code: 0,
    data: { items: [{ table_id: "tbl_main", name: "Table 1" }] },
  }));
  const appTableFieldList = vi.fn(async () => ({ code: 0, data: { items: [] } }));
  const client = {
    bitable: {
      app: {
        get: vi.fn(async () => ({
          code: 0,
          data: {
            app: {
              name: "Project Tracker",
            },
          },
        })),
        create: vi.fn(async () => ({
          code: 0,
          data: {
            app: {
              app_token: "app_token",
              name: "Project Tracker",
              url: "https://example.feishu.cn/base/app_token",
            },
          },
        })),
      },
      appTable: {
        list: appTableList,
      },
      appTableField: {
        list: appTableFieldList,
        update: vi.fn(async () => ({ code: 0 })),
        delete: vi.fn(async () => ({ code: 0 })),
      },
      appTableRecord: {
        list: vi.fn(async () => ({ code: 0, data: { items: records } })),
        batchDelete,
        delete: vi.fn(async () => ({ code: 0 })),
      },
    },
  } as unknown as Lark.Client;

  return { appTableFieldList, appTableList, batchDelete, client };
}

describe("feishu bitable tools", () => {
  afterAll(() => {
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  beforeEach(() => {
    createFeishuClientMock.mockReset();
  });

  it("deletes placeholder rows whose fields contain only default empty values", async () => {
    const { batchDelete, client } = createBitableClient([
      { record_id: "rec_missing_fields" },
      { record_id: "rec_empty_fields", fields: {} },
      {
        record_id: "rec_empty_defaults",
        fields: {
          Name: "",
          Status: [],
          Attachments: [],
          Started: null,
          EmptyObject: {},
        },
      },
      {
        record_id: "rec_empty_rich_text",
        fields: { Notes: [{ type: "text", text: "" }] },
      },
      {
        record_id: "rec_empty_nested",
        fields: { Notes: { value: "", segments: [{ type: "text", text: "" }] } },
      },
      { record_id: "rec_text", fields: { Name: "Milestone" } },
      { record_id: "rec_number", fields: { Estimate: 0 } },
      { record_id: "rec_boolean", fields: { Done: false } },
      { record_id: "rec_link", fields: { Link: { text: "", link: "https://example.com" } } },
      { record_id: "rec_attachment", fields: { Attachments: [{ file_token: "boxcn_token" }] } },
      { record_id: "rec_user", fields: { Assignee: [{ id: "ou_1", name: "" }] } },
      { record_id: "rec_location", fields: { Location: { name: "", location: "116,39" } } },
    ]);
    createFeishuClientMock.mockReturnValue(client);

    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuBitableTools(api);

    const result = await resolveTool("feishu_bitable_create_app").execute("call", {
      name: "Project Tracker",
    });

    expect(result.details.cleaned_placeholder_rows).toBe(5);
    expect(batchDelete).toHaveBeenCalledWith({
      path: { app_token: "app_token", table_id: "tbl_main" },
      data: {
        records: [
          "rec_missing_fields",
          "rec_empty_fields",
          "rec_empty_defaults",
          "rec_empty_rich_text",
          "rec_empty_nested",
        ],
      },
    });
  });

  it("get_meta accumulates tables from every Bitable table page", async () => {
    const { appTableList, client } = createBitableClient([]);
    appTableList.mockReset();
    appTableList
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ table_id: "tbl_first", name: "First Table" }],
          has_more: true,
          page_token: "page-2",
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ table_id: "tbl_second", name: "Second Table" }],
          has_more: false,
        },
      });
    createFeishuClientMock.mockReturnValue(client);

    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuBitableTools(api);

    const result = await resolveTool("feishu_bitable_get_meta").execute("call_get_meta", {
      url: "https://example.feishu.cn/base/apptoken",
    });

    expect(appTableList).toHaveBeenNthCalledWith(1, {
      path: { app_token: "apptoken" },
      params: { page_token: undefined },
    });
    expect(appTableList).toHaveBeenNthCalledWith(2, {
      path: { app_token: "apptoken" },
      params: { page_token: "page-2" },
    });
    expect(result.details.tables).toEqual([
      { table_id: "tbl_first", name: "First Table" },
      { table_id: "tbl_second", name: "Second Table" },
    ]);
  });

  it("list_fields accumulates fields from every Bitable field page", async () => {
    const { appTableFieldList, client } = createBitableClient([]);
    appTableFieldList.mockReset();
    appTableFieldList
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            { field_id: "fld_name", field_name: "Name", type: 1, is_primary: true },
          ],
          has_more: true,
          page_token: "page-2",
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            { field_id: "fld_due", field_name: "Due Date", type: 5, is_primary: false },
          ],
          has_more: false,
        },
      });
    createFeishuClientMock.mockReturnValue(client);

    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuBitableTools(api);

    const result = await resolveTool("feishu_bitable_list_fields").execute(
      "call_list_fields",
      {
        app_token: "app_token",
        table_id: "tbl_main",
      },
    );

    expect(appTableFieldList).toHaveBeenNthCalledWith(1, {
      path: { app_token: "app_token", table_id: "tbl_main" },
      params: { page_token: undefined },
    });
    expect(appTableFieldList).toHaveBeenNthCalledWith(2, {
      path: { app_token: "app_token", table_id: "tbl_main" },
      params: { page_token: "page-2" },
    });
    expect(result.details).toMatchObject({
      fields: [
        {
          field_id: "fld_name",
          field_name: "Name",
          type: 1,
          type_name: "Text",
          is_primary: true,
        },
        {
          field_id: "fld_due",
          field_name: "Due Date",
          type: 5,
          type_name: "DateTime",
          is_primary: false,
        },
      ],
      total: 2,
    });
  });

  it("advertises and validates list_records page_size as a positive integer", async () => {
    const { client } = createBitableClient([{ record_id: "rec_1", fields: { Name: "A" } }]);
    createFeishuClientMock.mockReturnValue(client);

    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuBitableTools(api);
    const tool = resolveTool("feishu_bitable_list_records");
    const parameters = tool as unknown as {
      parameters?: { properties?: { page_size?: Record<string, unknown> } };
    };
    expect(parameters.parameters?.properties?.page_size).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 500,
    });

    await tool.execute("call_list_records", {
      app_token: "app_token",
      table_id: "tbl_main",
      page_size: "25",
    });
    expect(client.bitable.appTableRecord.list).toHaveBeenLastCalledWith({
      path: { app_token: "app_token", table_id: "tbl_main" },
      params: { page_size: 25 },
    });

    const invalid = await tool.execute("call_invalid_page_size", {
      app_token: "app_token",
      table_id: "tbl_main",
      page_size: 0,
    });
    expect(invalid.details.error).toContain(
      "page_size must be a positive integer between 1 and 500",
    );
    expect(client.bitable.appTableRecord.list).toHaveBeenCalledTimes(1);
  });
});
