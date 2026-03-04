import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, test, vi } from "vitest";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";
import { registerFeishuWikiTools } from "./wiki.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const getNodeMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: (account: { appId?: string } | undefined) => {
    return createFeishuClientMock(account);
  },
}));

describe("feishu_wiki", () => {
  test("get returns sheet_read_hint for sheet nodes", async () => {
    createFeishuClientMock.mockReturnValue({
      wiki: {
        space: {
          getNode: getNodeMock,
        },
      },
    });

    getNodeMock.mockResolvedValue({
      code: 0,
      data: {
        node: {
          node_token: "node_1",
          space_id: "space_1",
          obj_token: "spreadsheet_1",
          obj_type: "sheet",
          title: "My sheet",
          parent_node_token: "parent_1",
          has_child: false,
          creator: { name: "me" },
          node_create_time: "2026-01-01",
        },
      },
    });

    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            main: {
              appId: "app-id",
              appSecret: "app-secret",
            },
          },
        },
      },
    } as OpenClawPluginApi["config"];

    const { api, resolveTool } = createToolFactoryHarness(cfg);
    registerFeishuWikiTools(api);

    const tool = resolveTool("feishu_wiki");
    const { details } = (await tool.execute("call", {
      action: "get",
      token: "node_1",
    })) as { details: Record<string, unknown> };

    expect(details.obj_type).toBe("sheet");
    expect(details.obj_token).toBe("spreadsheet_1");
    expect(details.sheet_read_hint).toContain("Use feishu_sheets_read_range");
  });
});
