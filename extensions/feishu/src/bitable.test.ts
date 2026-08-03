// Feishu tests cover bitable plugin behavior.
import * as Lark from "@larksuiteoapi/node-sdk";
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
  const client = {
    bitable: {
      app: {
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
        list: vi.fn(async () => ({
          code: 0,
          data: { items: [{ table_id: "tbl_main", name: "Table 1" }] },
        })),
      },
      appTableField: {
        list: vi.fn(async () => ({ code: 0, data: { items: [] } })),
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

  return { batchDelete, client };
}

type BitableSdkResponse = {
  code: number;
  msg?: string;
  data?: Record<string, unknown>;
};

function createSdkBitableClient(responses: Array<BitableSdkResponse | Error>) {
  const request = vi.fn(async (options: Lark.HttpRequestOptions<unknown>) => {
    const response = responses.shift();
    if (!response) {
      throw new Error(`Unexpected Feishu SDK request: ${String(options.url)}`);
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  });
  const post = vi.fn(() => {
    throw new Error("Unexpected Feishu SDK authentication request");
  });
  const httpInstance = Object.assign(Object.create(Lark.defaultHttpInstance) as Lark.HttpInstance, {
    request,
    post,
  });
  createFeishuClientMock.mockReturnValue(
    new Lark.Client({
      appId: "cli_bitable_pagination",
      appSecret: "bitable-test-placeholder", // pragma: allowlist secret
      disableTokenCache: true,
      loggerLevel: Lark.LoggerLevel.error,
      httpInstance,
    }),
  );
  return { request, post };
}

const bitablePaginationCases = [
  {
    name: "table metadata",
    toolName: "feishu_bitable_get_meta",
    params: { url: "https://example.feishu.cn/base/appToken123" },
    resourcePath: "/open-apis/bitable/v1/apps/appToken123/tables",
    firstItem: { table_id: "tblFirst", name: "First" },
    secondItem: { table_id: "tblSecond", name: "Second" },
    prefix: [{ code: 0, data: { app: { name: "Project Tracker" } } }],
  },
  {
    name: "table fields",
    toolName: "feishu_bitable_list_fields",
    params: { app_token: "appToken123", table_id: "tblMain" },
    resourcePath: "/open-apis/bitable/v1/apps/appToken123/tables/tblMain/fields",
    firstItem: { field_id: "fldFirst", field_name: "First", type: 1 },
    secondItem: { field_id: "fldSecond", field_name: "Second", type: 2 },
    prefix: [],
  },
] as const;

describe("feishu bitable create app cleanup", () => {
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

  it("preserves the selected table in a Bitable URL without listing other tables", async () => {
    const { request, post } = createSdkBitableClient([
      { code: 0, data: { app: { name: "Project Tracker" } } },
    ]);
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuBitableTools(api);

    const result = await resolveTool("feishu_bitable_get_meta").execute("call_selected_table", {
      url: "https://example.feishu.cn/base/appToken123?table=tblSelected",
    });

    expect(result.details).toMatchObject({
      app_token: "appToken123",
      table_id: "tblSelected",
      url_type: "base",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });

  it("resolves wiki Bitable URLs through the installed Feishu SDK", async () => {
    const { request, post } = createSdkBitableClient([
      { code: 0, data: { node: { obj_type: "bitable", obj_token: "appToken123" } } },
      { code: 0, data: { app: { name: "Project Tracker" } } },
      { code: 0, data: { items: [{ table_id: "tblMain", name: "Main" }] } },
    ]);
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuBitableTools(api);

    const result = await resolveTool("feishu_bitable_get_meta").execute("call_wiki_table", {
      url: "https://example.feishu.cn/wiki/wikiToken123",
    });

    expect(result.details).toMatchObject({
      app_token: "appToken123",
      url_type: "wiki",
      tables: [{ table_id: "tblMain", name: "Main" }],
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(post).not.toHaveBeenCalled();
  });

  it.each(bitablePaginationCases)(
    "returns every $name page through the installed Feishu SDK transport",
    async ({ toolName, params, resourcePath, firstItem, secondItem, prefix }) => {
      const { request, post } = createSdkBitableClient([
        ...prefix,
        {
          code: 0,
          data: { items: [firstItem], has_more: true, page_token: " page-2 ", total: 2 },
        },
        { code: 0, data: { items: [secondItem], has_more: false, total: 2 } },
      ]);
      const { api, resolveTool } = createToolFactoryHarness(createConfig());
      registerFeishuBitableTools(api);

      const result = await resolveTool(toolName).execute("call_bitable_pages", params);
      const rows =
        toolName === "feishu_bitable_get_meta" ? result.details.tables : result.details.fields;

      expect(rows).toEqual([
        expect.objectContaining(firstItem),
        expect.objectContaining(secondItem),
      ]);
      if (toolName === "feishu_bitable_list_fields") {
        expect(result.details.total).toBe(2);
      }
      const resourceCalls = request.mock.calls.filter(([options]) =>
        options.url?.endsWith(resourcePath),
      );
      expect(resourceCalls.map(([options]) => options)).toEqual([
        expect.objectContaining({ method: "GET", params: { page_size: 100 } }),
        expect.objectContaining({
          method: "GET",
          params: { page_size: 100, page_token: " page-2 " },
        }),
      ]);
      expect(post).not.toHaveBeenCalled();
    },
  );

  it.each(bitablePaginationCases)(
    "preserves distinct whitespace-bearing opaque $name page tokens",
    async ({ toolName, params, resourcePath, firstItem, secondItem, prefix }) => {
      const { request, post } = createSdkBitableClient([
        ...prefix,
        { code: 0, data: { items: [firstItem], has_more: true, page_token: "page-2" } },
        { code: 0, data: { items: [], has_more: true, page_token: " page-2 " } },
        { code: 0, data: { items: [secondItem], has_more: false } },
      ]);
      const { api, resolveTool } = createToolFactoryHarness(createConfig());
      registerFeishuBitableTools(api);

      const result = await resolveTool(toolName).execute("call_bitable_opaque_pages", params);
      const rows =
        toolName === "feishu_bitable_get_meta" ? result.details.tables : result.details.fields;

      expect(rows).toEqual([
        expect.objectContaining(firstItem),
        expect.objectContaining(secondItem),
      ]);
      const resourceCalls = request.mock.calls.filter(([options]) =>
        options.url?.endsWith(resourcePath),
      );
      expect(resourceCalls.map(([options]) => options.params)).toEqual([
        { page_size: 100 },
        { page_size: 100, page_token: "page-2" },
        { page_size: 100, page_token: " page-2 " },
      ]);
      expect(post).not.toHaveBeenCalled();
    },
  );

  it.each(bitablePaginationCases)(
    "surfaces a later $name provider failure instead of returning partial success",
    async ({ toolName, params, firstItem, prefix }) => {
      const { request, post } = createSdkBitableClient([
        ...prefix,
        { code: 0, data: { items: [firstItem], has_more: true, page_token: "page-2" } },
        { code: 91403, msg: "Bitable access was revoked" },
      ]);
      const { api, resolveTool } = createToolFactoryHarness(createConfig());
      registerFeishuBitableTools(api);

      const result = await resolveTool(toolName).execute("call_bitable_provider_error", params);

      expect(result.details.error).toContain("Bitable access was revoked");
      expect(request).toHaveBeenCalledTimes(prefix.length + 2);
      expect(post).not.toHaveBeenCalled();
    },
  );

  it.each(bitablePaginationCases)(
    "rejects a missing next-page cursor for $name",
    async ({ toolName, params, firstItem, prefix }) => {
      const { post } = createSdkBitableClient([
        ...prefix,
        { code: 0, data: { items: [firstItem], has_more: true, page_token: "  " } },
      ]);
      const { api, resolveTool } = createToolFactoryHarness(createConfig());
      registerFeishuBitableTools(api);

      const result = await resolveTool(toolName).execute("call_bitable_missing_cursor", params);

      expect(result.details.error).toMatch(/missing.*page token/i);
      expect(post).not.toHaveBeenCalled();
    },
  );

  it.each(bitablePaginationCases)(
    "propagates a later $name HTTP transport failure",
    async ({ toolName, params, firstItem, prefix }) => {
      const { request, post } = createSdkBitableClient([
        ...prefix,
        { code: 0, data: { items: [firstItem], has_more: true, page_token: "page-2" } },
        new Error("Feishu transport disconnected"),
      ]);
      const { api, resolveTool } = createToolFactoryHarness(createConfig());
      registerFeishuBitableTools(api);

      const result = await resolveTool(toolName).execute("call_bitable_transport_error", params);

      expect(result.details.error).toContain("Feishu transport disconnected");
      expect(request).toHaveBeenCalledTimes(prefix.length + 2);
      expect(post).not.toHaveBeenCalled();
    },
  );

  it.each(bitablePaginationCases)(
    "rejects a repeated next-page cursor for $name",
    async ({ toolName, params, firstItem, prefix }) => {
      const { request, post } = createSdkBitableClient([
        ...prefix,
        { code: 0, data: { items: [firstItem], has_more: true, page_token: "same-page" } },
        { code: 0, data: { items: [], has_more: true, page_token: "same-page" } },
      ]);
      const { api, resolveTool } = createToolFactoryHarness(createConfig());
      registerFeishuBitableTools(api);

      const result = await resolveTool(toolName).execute("call_bitable_repeated_cursor", params);

      expect(result.details.error).toMatch(/repeated.*page token/i);
      expect(request).toHaveBeenCalledTimes(prefix.length + 2);
      expect(post).not.toHaveBeenCalled();
    },
  );

  it.each(bitablePaginationCases)(
    "rejects a successful $name response without provider data",
    async ({ toolName, params, prefix }) => {
      const { post } = createSdkBitableClient([...prefix, { code: 0 }]);
      const { api, resolveTool } = createToolFactoryHarness(createConfig());
      registerFeishuBitableTools(api);

      const result = await resolveTool(toolName).execute("call_bitable_missing_data", params);

      expect(result.details.error).toMatch(/missing.*data/i);
      expect(post).not.toHaveBeenCalled();
    },
  );

  it("bounds table field pagination before a provider can loop indefinitely", async () => {
    const pages = Array.from({ length: 101 }, (_, index) => ({
      code: 0,
      data: { items: [], has_more: true, page_token: `page-${index + 1}` },
    }));
    const { request, post } = createSdkBitableClient(pages);
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuBitableTools(api);

    const result = await resolveTool("feishu_bitable_list_fields").execute(
      "call_bitable_page_cap",
      {
        app_token: "appToken123",
        table_id: "tblMain",
      },
    );

    expect(result.details.error).toMatch(/pagination exceeded 100 pages/i);
    expect(request).toHaveBeenCalledTimes(100);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("feishu bitable write tool schemas (#94547)", () => {
  it.each([
    ["feishu_bitable_create_record", "fields"],
    ["feishu_bitable_update_record", "fields"],
    ["feishu_bitable_create_field", "property"],
  ])("%s emits a non-empty value schema for %s", (toolName, propName) => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuBitableTools(api);

    const tool = resolveTool(toolName) as unknown as {
      parameters?: {
        properties?: Record<
          string,
          { patternProperties?: Record<string, Record<string, unknown>> }
        >;
      };
    };
    const patternSchemas = Object.values(
      tool.parameters?.properties?.[propName]?.patternProperties ?? {},
    );
    expect(patternSchemas).toEqual([
      { type: ["string", "number", "boolean", "object", "array", "null"] },
    ]);
  });
});
