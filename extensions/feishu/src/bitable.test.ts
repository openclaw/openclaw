import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerFeishuBitableTools } from "./bitable.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

function createConfig(): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        enabled: true,
        appId: "app_id",
        appSecret: "app_secret", // pragma: allowlist secret
      },
    },
  } as OpenClawPluginApi["config"];
}

function createBitableClient(
  records: Array<{ record_id?: string; fields?: Record<string, unknown> }>,
) {
  return {
    bitable: {
      app: {
        create: vi.fn().mockResolvedValue({
          code: 0,
          data: {
            app: {
              app_token: "app_token_1",
              name: "Cleanup test",
              url: "https://example.feishu.cn/base/app_token_1",
            },
          },
        }),
      },
      appTable: {
        list: vi.fn().mockResolvedValue({
          code: 0,
          data: { items: [{ table_id: "tbl_1", name: "Table 1" }] },
        }),
      },
      appTableField: {
        list: vi.fn().mockResolvedValue({
          code: 0,
          data: { items: [] },
        }),
        update: vi.fn().mockResolvedValue({ code: 0 }),
        delete: vi.fn().mockResolvedValue({ code: 0 }),
      },
      appTableRecord: {
        list: vi.fn().mockResolvedValue({
          code: 0,
          data: { items: records },
        }),
        batchDelete: vi.fn().mockResolvedValue({ code: 0 }),
        delete: vi.fn().mockResolvedValue({ code: 0 }),
      },
    },
  };
}

describe("feishu bitable create app cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes placeholder rows with present-but-empty values without deleting meaningful rows", async () => {
    const client = createBitableClient([
      { record_id: "rec_empty_string", fields: { Text: "" } },
      { record_id: "rec_null", fields: { Text: null } },
      { record_id: "rec_empty_array", fields: { Multi: [] } },
      {
        record_id: "rec_empty_rich_text",
        fields: { RichText: [{ type: "text", text: "" }] },
      },
      {
        record_id: "rec_empty_nested",
        fields: { Nested: { value: "", detail: null, segments: [{ type: "text", text: "" }] } },
      },
      { record_id: "rec_no_fields", fields: {} },
      { record_id: "rec_missing_fields" },
      { record_id: "rec_text", fields: { Text: "keep me" } },
      { record_id: "rec_zero", fields: { Number: 0 } },
      { record_id: "rec_false", fields: { Checkbox: false } },
      { record_id: "rec_url", fields: { URL: { text: "", link: "https://example.com" } } },
      {
        record_id: "rec_attachment",
        fields: { Attachment: [{ file_token: "boxcn_token", name: "" }] },
      },
      { record_id: "rec_user", fields: { User: [{ id: "ou_1", name: "" }] } },
      {
        record_id: "rec_location",
        fields: { Location: { name: "", full_address: "", location: "116,39" } },
      },
      {
        record_id: "rec_rich_link",
        fields: { RichText: [{ type: "text", text: "", link: "https://example.com" }] },
      },
    ]);
    createFeishuClientMock.mockReturnValue(client);

    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuBitableTools(api);

    const result = (await resolveTool("feishu_bitable_create_app").execute("call_1", {
      name: "Cleanup test",
    })) as { details: { cleaned_placeholder_rows: number } };

    expect(result.details.cleaned_placeholder_rows).toBe(7);
    expect(client.bitable.appTableRecord.batchDelete).toHaveBeenCalledWith({
      path: { app_token: "app_token_1", table_id: "tbl_1" },
      data: {
        records: [
          "rec_empty_string",
          "rec_null",
          "rec_empty_array",
          "rec_empty_rich_text",
          "rec_empty_nested",
          "rec_no_fields",
          "rec_missing_fields",
        ],
      },
    });
    expect(client.bitable.appTableRecord.delete).not.toHaveBeenCalled();
  });
});
