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
});

describe("feishu bitable write tool schemas", () => {
  // AWS Bedrock enforces strict JSON Schema draft 2020-12 and rejects empty
  // sub-schemas (`{}`). `Type.Record(Type.String(), Type.Any())` previously
  // serialized to `patternProperties: { "^.*$": {} }` with an empty value
  // sub-schema (Type.Any() -> `{}`), which Bedrock rejects, failing the
  // entire tool list. Verify the bitable write tools emit a non-empty value
  // sub-schema for every record-typed parameter.
  function recordValueSchema(parameters: unknown, paramKey: string): unknown {
    const param = (parameters as { properties?: Record<string, unknown> }).properties?.[paramKey];
    // Type.Optional(Type.Record(...)) wraps the record in anyOf; unwrap it.
    const recordSchema = (param as { anyOf?: unknown[] })?.anyOf?.[0] ?? param;
    return (recordSchema as { patternProperties?: { "^.*$"?: unknown } }).patternProperties?.["^.*$"];
  }

  it("create_record fields value schema is non-empty (no empty patternProperties sub-schema)", () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuBitableTools(api);
    const tool = resolveTool("feishu_bitable_create_record");
    const parameters = (tool as unknown as { parameters?: unknown }).parameters;

    const valueSchema = recordValueSchema(parameters, "fields");
    expect(valueSchema).not.toEqual({});
    expect(valueSchema).toMatchObject({ anyOf: expect.any(Array) });
    // No empty sub-schema as the patternProperties value anywhere in the tool.
    expect(JSON.stringify(parameters)).not.toContain('"patternProperties":{"^.*$":{}}');
  });

  it("update_record fields value schema is non-empty", () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuBitableTools(api);
    const tool = resolveTool("feishu_bitable_update_record");
    const parameters = (tool as unknown as { parameters?: unknown }).parameters;

    const valueSchema = recordValueSchema(parameters, "fields");
    expect(valueSchema).not.toEqual({});
    expect(valueSchema).toMatchObject({ anyOf: expect.any(Array) });
    expect(JSON.stringify(parameters)).not.toContain('"patternProperties":{"^.*$":{}}');
  });

  it("create_field property value schema is non-empty", () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuBitableTools(api);
    const tool = resolveTool("feishu_bitable_create_field");
    const parameters = (tool as unknown as { parameters?: unknown }).parameters;

    const valueSchema = recordValueSchema(parameters, "property");
    expect(valueSchema).not.toEqual({});
    expect(valueSchema).toMatchObject({ anyOf: expect.any(Array) });
    expect(JSON.stringify(parameters)).not.toContain('"patternProperties":{"^.*$":{}}');
  });

  it("accepts Feishu user field value (array of objects)", () => {
    // Feishu bitable user fields are arrays of objects: [{id:"ou_xxx"}].
    // The value schema must accept open objects inside arrays, not just
    // primitives, to avoid rejecting valid Feishu payloads.
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuBitableTools(api);
    const tool = resolveTool("feishu_bitable_create_record");
    const parameters = (tool as unknown as { parameters?: unknown }).parameters;
    const serialized = JSON.stringify(parameters);

    // The array branch items must include an open-object option
    // (additionalProperties: true), not just primitive types.
    expect(serialized).toContain('"additionalProperties":true');
    // Verify the array items union has at least 5 branches (primitives + open object)
    const valueSchema = recordValueSchema(parameters, "fields");
    const anyOf = (valueSchema as { anyOf?: unknown[] })?.anyOf;
    const arrayBranch = anyOf?.find(
      (b) => (b as { type?: string })?.type === "array",
    ) as { items?: { anyOf?: unknown[] } } | undefined;
    expect(arrayBranch?.items?.anyOf?.length).toBeGreaterThanOrEqual(5);
  });

  it("accepts Feishu create_field property.options (array of option objects)", () => {
    // property.options for SingleSelect/MultiSelect fields is [{name:"A"}].
    // The value schema must allow arrays containing objects.
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuBitableTools(api);
    const tool = resolveTool("feishu_bitable_create_field");
    const parameters = (tool as unknown as { parameters?: unknown }).parameters;
    const valueSchema = recordValueSchema(parameters, "property");

    const anyOf = (valueSchema as { anyOf?: unknown[] })?.anyOf;
    const arrayBranch = anyOf?.find(
      (b) => (b as { type?: string })?.type === "array",
    ) as { items?: { anyOf?: unknown[] } } | undefined;
    // Array items must include an open-object branch for option objects
    const objectBranch = arrayBranch?.items?.anyOf?.find(
      (b) =>
        (b as { type?: string })?.type === "object" &&
        (b as { additionalProperties?: unknown })?.additionalProperties === true,
    );
    expect(objectBranch).toBeDefined();
  });
});
