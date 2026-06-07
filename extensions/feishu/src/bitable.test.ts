// Feishu tests cover bitable plugin behavior.
import type * as Lark from "@larksuiteoapi/node-sdk";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

import { registerFeishuBitableTools, getBitableMeta, parseBitableUrl } from "./bitable.js";

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

function createMockLarkClient(): Lark.Client {
  return {
    bitable: {
      app: {
        get: vi.fn(async () => ({
          code: 0,
          msg: "ok",
          data: { app: { name: "Mock Bitable" } },
        })),
      },
      appTable: {
        list: vi.fn(async () => ({ code: 0, msg: "ok", data: { items: [] } })),
      },
    },
    wiki: {
      space: {
        getNode: vi.fn(async () => ({ code: 0, msg: "ok", data: { node: null } })),
      },
    },
  } as unknown as Lark.Client;
}

describe("parseBitableUrl", () => {
  it("parses a /base/ URL with an alphanumeric token", () => {
    expect(parseBitableUrl("https://example.feishu.cn/base/abc123def456")).toEqual({
      token: "abc123def456",
      tableId: undefined,
      isWiki: false,
    });
  });

  it("parses a /wiki/ URL with a table query parameter", () => {
    expect(parseBitableUrl("https://my.feishu.cn/wiki/wikiTok123?table=tblABC")).toEqual({
      token: "wikiTok123",
      tableId: "tblABC",
      isWiki: true,
    });
  });

  it("preserves tokens that contain hyphens or underscores", () => {
    // Current Lark tokens are alphanumeric, but the character class is
    // deliberately permissive so future token shapes are not silently
    // truncated. Any unrecognized characters are passed through unchanged
    // and surfaced via the upstream API call instead of being lost here.
    expect(parseBitableUrl("https://example.feishu.cn/base/abc-123_xyz")).toEqual({
      token: "abc-123_xyz",
      tableId: undefined,
      isWiki: false,
    });
  });

  it("returns null for a URL that is not a /base/ or /wiki/ path", () => {
    expect(parseBitableUrl("https://example.feishu.cn/docs/abc123")).toBeNull();
    expect(parseBitableUrl("https://example.feishu.cn/sheets/abc123")).toBeNull();
  });

  it("returns null for a syntactically invalid URL", () => {
    expect(parseBitableUrl("not a url")).toBeNull();
    expect(parseBitableUrl("")).toBeNull();
  });
});

describe("getBitableMeta error context", () => {
  it("includes the offending URL in the thrown error message", async () => {
    const client = createMockLarkClient();
    const badUrl = "https://example.feishu.cn/docs/not-a-bitable";

    await expect(getBitableMeta(client, badUrl)).rejects.toThrow(
      /Invalid bitable URL: "https:\/\/example\.feishu\.cn\/docs\/not-a-bitable"/,
    );
  });
});
