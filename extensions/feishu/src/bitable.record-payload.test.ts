import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerFeishuBitableTools } from "./bitable.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createRecordMock = vi.hoisted(() => vi.fn());
const updateRecordMock = vi.hoisted(() => vi.fn());
const createFeishuToolClientMock = vi.hoisted(() => vi.fn());

vi.mock("./tool-account.js", () => ({
  createFeishuToolClient: (...args: unknown[]) => createFeishuToolClientMock(...args),
}));

function createConfig(): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          main: {
            appId: "cli_main",
            appSecret: "sec_main",
          },
        },
      },
    },
  } as OpenClawPluginApi["config"];
}

function setupTool(name: "feishu_bitable_create_record" | "feishu_bitable_update_record") {
  const { api, resolveTool } = createToolFactoryHarness(createConfig());
  registerFeishuBitableTools(api);
  return resolveTool(name, { agentAccountId: "main" });
}

function readError(result: unknown): string | undefined {
  const details = (result as { details?: { error?: string } })?.details;
  return details?.error;
}

function captureToolParameters(name: string): Record<string, unknown> {
  const registered: Array<{
    tool: unknown;
    opts?: { name?: string };
  }> = [];

  const api = {
    config: createConfig(),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    registerTool: (tool: unknown, opts?: { name?: string }) => {
      registered.push({ tool, opts });
    },
  } as unknown as OpenClawPluginApi;

  registerFeishuBitableTools(api);
  const hit = registered.find((entry) => entry.opts?.name === name);
  if (!hit || typeof hit.tool !== "function") {
    throw new Error(`Tool not registered: ${name}`);
  }

  const resolved = (hit.tool as (ctx: { agentAccountId?: string }) => { parameters?: unknown })({
    agentAccountId: "main",
  });
  return (resolved.parameters ?? {}) as Record<string, unknown>;
}

describe("feishu bitable record payload", () => {
  beforeEach(() => {
    createRecordMock.mockReset();
    updateRecordMock.mockReset();
    createFeishuToolClientMock.mockReset();

    createRecordMock.mockResolvedValue({
      code: 0,
      data: { record: { record_id: "rec_create" } },
    });
    updateRecordMock.mockResolvedValue({
      code: 0,
      data: { record: { record_id: "rec_update" } },
    });

    createFeishuToolClientMock.mockReturnValue({
      bitable: {
        appTableRecord: {
          create: createRecordMock,
          update: updateRecordMock,
        },
      },
    });
  });

  test("create/update schemas expose fields_json fallback parameter", () => {
    const createParams = captureToolParameters("feishu_bitable_create_record");
    const updateParams = captureToolParameters("feishu_bitable_update_record");

    const createProperties = (createParams.properties ?? {}) as Record<string, { type?: string }>;
    const updateProperties = (updateParams.properties ?? {}) as Record<string, { type?: string }>;

    expect(createProperties.fields_json?.type).toBe("string");
    expect(updateProperties.fields_json?.type).toBe("string");
    expect(createProperties.fields).toBeTruthy();
    expect(updateProperties.fields).toBeTruthy();
  });

  test("create_record accepts fields_json fallback payload", async () => {
    const tool = setupTool("feishu_bitable_create_record");

    await tool.execute("call", {
      app_token: "app_x",
      table_id: "tbl_x",
      fields_json: '{"Name":"Alice","Score":95}',
    });

    expect(createRecordMock).toHaveBeenCalledWith({
      path: { app_token: "app_x", table_id: "tbl_x" },
      data: { fields: { Name: "Alice", Score: 95 } },
    });
  });

  test("update_record keeps compatibility with object fields payload", async () => {
    const tool = setupTool("feishu_bitable_update_record");

    await tool.execute("call", {
      app_token: "app_x",
      table_id: "tbl_x",
      record_id: "rec_x",
      fields: { Status: "Done" },
    });

    expect(updateRecordMock).toHaveBeenCalledWith({
      path: { app_token: "app_x", table_id: "tbl_x", record_id: "rec_x" },
      data: { fields: { Status: "Done" } },
    });
  });

  test("create_record rejects payload when fields and fields_json are both provided", async () => {
    const tool = setupTool("feishu_bitable_create_record");

    const result = await tool.execute("call", {
      app_token: "app_x",
      table_id: "tbl_x",
      fields: { Name: "Alice" },
      fields_json: '{"Name":"Bob"}',
    });

    expect(readError(result)).toContain("Provide either fields or fields_json");
    expect(createRecordMock).not.toHaveBeenCalled();
  });

  test("update_record rejects invalid or empty fields_json", async () => {
    const tool = setupTool("feishu_bitable_update_record");

    const invalidJson = await tool.execute("call-invalid", {
      app_token: "app_x",
      table_id: "tbl_x",
      record_id: "rec_x",
      fields_json: "{bad}",
    });

    expect(readError(invalidJson)).toContain("Invalid fields_json");
    expect(updateRecordMock).not.toHaveBeenCalled();

    const emptyObject = await tool.execute("call-empty", {
      app_token: "app_x",
      table_id: "tbl_x",
      record_id: "rec_x",
      fields_json: "{}",
    });

    expect(readError(emptyObject)).toContain("Record fields cannot be empty");
    expect(updateRecordMock).not.toHaveBeenCalled();
  });
});
