import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFeishuBitableTools } from "./bitable.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/feishu";

const mockListRecords = vi.fn();

vi.mock("./client.js", () => ({
  createFeishuClient: () => ({
    bitable: {
      appTableRecord: {
        list: mockListRecords,
      },
    },
  }),
}));

function successResponse(items: unknown[] = []) {
  return {
    code: 0,
    data: { items, has_more: false, page_token: undefined, total: items.length },
  };
}

function setupHarness() {
  const cfg = {
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          default: { appId: "app-1", appSecret: "sec-1" },
        },
      },
    },
  } as OpenClawPluginApi["config"];
  const { api, resolveTool } = createToolFactoryHarness(cfg);
  registerFeishuBitableTools(api);
  return resolveTool;
}

describe("feishu_bitable_list_records filter/sort/field_names passthrough", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes filter expression to the Feishu API", async () => {
    mockListRecords.mockResolvedValue(successResponse());
    const resolveTool = setupHarness();
    const tool = resolveTool("feishu_bitable_list_records");

    await tool.execute("call-1", {
      app_token: "tok",
      table_id: "tbl",
      filter: 'CurrentValue.[Status]="Open"',
    });

    expect(mockListRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ filter: 'CurrentValue.[Status]="Open"' }),
      }),
    );
  });

  it("serializes sort array to JSON string for the Feishu API", async () => {
    mockListRecords.mockResolvedValue(successResponse());
    const resolveTool = setupHarness();
    const tool = resolveTool("feishu_bitable_list_records");

    await tool.execute("call-2", {
      app_token: "tok",
      table_id: "tbl",
      sort: ["Score DESC", "Name ASC"],
    });

    expect(mockListRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ sort: JSON.stringify(["Score DESC", "Name ASC"]) }),
      }),
    );
  });

  it("serializes field_names array to JSON string for the Feishu API", async () => {
    mockListRecords.mockResolvedValue(successResponse());
    const resolveTool = setupHarness();
    const tool = resolveTool("feishu_bitable_list_records");

    await tool.execute("call-3", {
      app_token: "tok",
      table_id: "tbl",
      field_names: ["Name", "Status"],
    });

    expect(mockListRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ field_names: JSON.stringify(["Name", "Status"]) }),
      }),
    );
  });

  it("passes view_id to the Feishu API", async () => {
    mockListRecords.mockResolvedValue(successResponse());
    const resolveTool = setupHarness();
    const tool = resolveTool("feishu_bitable_list_records");

    await tool.execute("call-4", { app_token: "tok", table_id: "tbl", view_id: "vew_abc123" });

    expect(mockListRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ view_id: "vew_abc123" }),
      }),
    );
  });

  it("omits filter/sort/field_names/view_id from params when not provided", async () => {
    mockListRecords.mockResolvedValue(successResponse());
    const resolveTool = setupHarness();
    const tool = resolveTool("feishu_bitable_list_records");

    await tool.execute("call-5", { app_token: "tok", table_id: "tbl" });

    const callParams = mockListRecords.mock.calls[0][0].params;
    expect(callParams).not.toHaveProperty("filter");
    expect(callParams).not.toHaveProperty("sort");
    expect(callParams).not.toHaveProperty("field_names");
    expect(callParams).not.toHaveProperty("view_id");
  });
});
