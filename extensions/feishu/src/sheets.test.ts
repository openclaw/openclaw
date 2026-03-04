import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { registerFeishuSheetsTools } from "./sheets.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const requestMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

function createConfig(tools?: { sheets?: boolean }): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          main: {
            appId: "app-id",
            appSecret: "app-secret",
            tools: tools,
          },
        },
      },
    },
  } as OpenClawPluginApi["config"];
}

describe("feishu_sheets_read_range", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    createFeishuClientMock.mockReturnValue({
      request: requestMock,
    });
  });

  function getTool() {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuSheetsTools(api);
    return resolveTool("feishu_sheets_read_range", { agentAccountId: "main" });
  }

  test("reads a known range", async () => {
    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          title: "Budget",
          row_count: 120,
          column_count: 4,
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          value_range: {
            range: "A1:C5",
            majorDimension: "GRID",
            values: [
              ["A", "B", "C"],
              [1, 2, 3],
            ],
          },
        },
      });

    const tool = getTool();
    const { details } = (await tool.execute("call", {
      spreadsheet_token: "ssp_xxx",
      sheet_id: "sh_xxx",
      range: "A1:C5",
    })) as { details: Record<string, unknown> };

    expect(details.spreadsheet_token).toBe("ssp_xxx");
    expect(details.sheet_id).toBe("sh_xxx");
    expect(details.requested_range).toBe("A1:C5");
    expect(details.resolved_range).toBe("A1:C5");
    expect(details.values).toEqual([
      ["A", "B", "C"],
      [1, 2, 3],
    ]);
    expect(details.value_range).toMatchObject({
      range: "A1:C5",
      row_count: 5,
      column_count: 3,
      major_dimension: "GRID",
    });
    expect(details.sheet_meta).toMatchObject({
      title: "Budget",
      row_count: 120,
      column_count: 4,
    });
    expect(details).not.toHaveProperty("markdown");

    expect(requestMock).toHaveBeenNthCalledWith(1, {
      method: "GET",
      url: "/open-apis/sheets/v2/spreadsheets/ssp_xxx/sheets/sh_xxx",
    });
    expect(requestMock).toHaveBeenNthCalledWith(2, {
      method: "GET",
      url: "/open-apis/sheets/v2/spreadsheets/ssp_xxx/sheets/sh_xxx/values/A1%3AC5",
    });
  });

  test("falls back to metadata range when range is omitted", async () => {
    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          title: "EmptyRangeSheet",
          row_count: 3,
          column_count: 2,
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          value_range: {
            values: [["x", "y"]],
          },
        },
      });

    const tool = getTool();
    const { details } = (await tool.execute("call", {
      spreadsheet_token: "ssp_xxx",
      sheet_id: "sh_xxx",
    })) as { details: Record<string, unknown> };

    expect(details.requested_range).toBeNull();
    expect(details.resolved_range).toBe("A1:B3");
    expect(details.value_range).toMatchObject({
      range: "A1:B3",
      row_count: 3,
      column_count: 2,
    });
  });

  test("treats blank range as omitted and falls back to metadata range", async () => {
    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          title: "BlankRangeSheet",
          row_count: 4,
          column_count: 3,
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          value_range: {
            values: [["x", "y", "z"]],
          },
        },
      });

    const tool = getTool();
    const { details } = (await tool.execute("call", {
      spreadsheet_token: "ssp_xxx",
      sheet_id: "sh_xxx",
      range: "   ",
    })) as { details: Record<string, unknown> };

    expect(details.requested_range).toBeNull();
    expect(details.resolved_range).toBe("A1:C4");
    expect(details.value_range).toMatchObject({
      range: "A1:C4",
      row_count: 4,
      column_count: 3,
    });
  });

  test("returns invalid_range error for bad range", async () => {
    const tool = getTool();
    const { details } = (await tool.execute("call", {
      spreadsheet_token: "ssp_xxx",
      sheet_id: "sh_xxx",
      range: "BAD",
    })) as { details: Record<string, unknown> };

    expect(requestMock).not.toHaveBeenCalled();

    expect(details.code).toBe("invalid_range");
    expect(details.error).toContain("Invalid A1 range");
    expect(details).not.toHaveProperty("next_range_hint");
  });

  test("returns read_error with next_range_hint for oversized range", async () => {
    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          title: "Large Sheet",
          row_count: 1200,
          column_count: 26,
        },
      })
      .mockResolvedValueOnce({
        code: 100,
        msg: "Request too large",
      });

    const tool = getTool();
    const { details } = (await tool.execute("call", {
      spreadsheet_token: "ssp_xxx",
      sheet_id: "sh_xxx",
      range: "A1:Z1000",
    })) as { details: Record<string, unknown> };
    expect(details.code).toBe("read_error");
    expect(details.error).toContain("Failed to read sheet values");
    expect(details.next_range_hint).toBe("A1:Z200");
  });

  test("returns read_error with next_range_hint when no range is provided and request is oversized", async () => {
    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          title: "Large Sheet",
          row_count: 1200,
          column_count: 4,
        },
      })
      .mockResolvedValueOnce({
        code: 100,
        msg: "Request too large",
      });

    const tool = getTool();
    const { details } = (await tool.execute("call", {
      spreadsheet_token: "ssp_xxx",
      sheet_id: "sh_xxx",
    })) as { details: Record<string, unknown> };
    expect(details.code).toBe("read_error");
    expect(details.error).toContain("Failed to read sheet values");
    expect(details.next_range_hint).toBe("A1:D200");
  });

  test("supports include_markdown output", async () => {
    requestMock
      .mockResolvedValueOnce({
        code: 0,
        data: {
          title: "Budget",
          row_count: 5,
          column_count: 2,
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          value_range: {
            range: "A1:B2",
            values: [
              ["Name", "Score"],
              ["Alice", 95],
            ],
          },
        },
      });

    const tool = getTool();
    const { details } = (await tool.execute("call", {
      spreadsheet_token: "ssp_xxx",
      sheet_id: "sh_xxx",
      include_markdown: true,
      range: "A1:B2",
    })) as { details: Record<string, unknown> };
    const markdown = details.markdown;

    expect(typeof markdown).toBe("string");
    expect(markdown).toContain("| C1 | C2 |");
    expect(markdown).toContain("| --- | --- |");
  });

  test("does not register tool when sheets is disabled", () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig({ sheets: false }));
    registerFeishuSheetsTools(api);
    expect(() => resolveTool("feishu_sheets_read_range")).toThrow(/Tool not registered/);
  });
});
