import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerFeishuChatTools } from "./chat.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

function createConfig(tools?: { chat?: boolean }): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          main: {
            appId: "app-id",
            appSecret: "app-secret",
            tools,
          },
        },
      },
    },
  } as OpenClawPluginApi["config"];
}

describe("registerFeishuChatTools", () => {
  const chatGetMock = vi.hoisted(() => vi.fn());
  const chatMembersGetMock = vi.hoisted(() => vi.fn());
  type ToolResult = { details: Record<string, unknown> };

  beforeEach(() => {
    vi.clearAllMocks();
    createFeishuClientMock.mockReturnValue({
      im: {
        chat: { get: chatGetMock },
        chatMembers: { get: chatMembersGetMock },
      },
    });
  });

  it("registers feishu_chat and handles info/members actions", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig({ chat: true }));
    registerFeishuChatTools(api);
    const tool = resolveTool("feishu_chat", { agentAccountId: "main" });

    expect(tool.name).toBe("feishu_chat");

    chatGetMock.mockResolvedValueOnce({
      code: 0,
      data: { name: "group name", user_count: 3 },
    });
    const infoResult = (await tool.execute("tc_1", {
      action: "info",
      chat_id: "oc_1",
    })) as ToolResult;
    expect(infoResult.details).toEqual(
      expect.objectContaining({ chat_id: "oc_1", name: "group name", user_count: 3 }),
    );

    chatMembersGetMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: false,
        page_token: "",
        items: [{ member_id: "ou_1", name: "member1", member_id_type: "open_id" }],
      },
    });
    const membersResult = (await tool.execute("tc_2", {
      action: "members",
      chat_id: "oc_1",
    })) as ToolResult;
    expect(membersResult.details).toEqual(
      expect.objectContaining({
        chat_id: "oc_1",
        members: [expect.objectContaining({ member_id: "ou_1", name: "member1" })],
      }),
    );
  });

  it("skips registration when chat tool is disabled", () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig({ chat: false }));
    registerFeishuChatTools(api);
    expect(() => resolveTool("feishu_chat")).toThrow(/Tool not registered/);
  });
});
