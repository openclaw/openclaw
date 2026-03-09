import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerFeishuChatTools } from "./chat.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: (...args: unknown[]) => createFeishuClientMock(...args),
}));

describe("registerFeishuChatTools", () => {
  const chatGetMock = vi.hoisted(() => vi.fn());
  const chatListMock = vi.hoisted(() => vi.fn());
  const chatMembersGetMock = vi.hoisted(() => vi.fn());

  beforeEach(() => {
    vi.clearAllMocks();
    createFeishuClientMock.mockReturnValue({
      im: {
        chat: { get: chatGetMock, list: chatListMock },
        chatMembers: { get: chatMembersGetMock },
      },
    });
  });

  function registerAndGetTool(agentAccountId?: string) {
    const { api, resolveTool } = createToolFactoryHarness({
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            default: {
              appId: "app_default",
              appSecret: "secret_default",
            },
            jim: {
              appId: "app_jim",
              appSecret: "secret_jim",
            },
          },
          tools: { chat: true },
        },
      },
    } as any);

    registerFeishuChatTools(api);
    return resolveTool("feishu_chat", { agentAccountId });
  }

  it("registers feishu_chat and handles info/members actions", async () => {
    const tool = registerAndGetTool();
    expect(tool.name).toBe("feishu_chat");

    chatGetMock.mockResolvedValueOnce({
      code: 0,
      data: { name: "group name", user_count: 3 },
    });
    const infoResult = (await tool.execute("tc_1", { action: "info", chat_id: "oc_1" })) as any;
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
    })) as any;
    expect(membersResult.details).toEqual(
      expect.objectContaining({
        chat_id: "oc_1",
        members: [expect.objectContaining({ member_id: "ou_1", name: "member1" })],
      }),
    );
  });

  it("skips registration when chat tool is disabled", () => {
    const { api } = createToolFactoryHarness({
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            default: {
              appId: "app_id",
              appSecret: "app_secret",
              tools: { chat: false },
            },
          },
        },
      },
    } as any);

    const registerTool = vi.fn();
    const wrappedApi = { ...api, registerTool };
    registerFeishuChatTools(wrappedApi as any);
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("list action returns chat items", async () => {
    const tool = registerAndGetTool();

    chatListMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: true,
        page_token: "next_page",
        items: [
          {
            chat_id: "oc_abc",
            name: "Test Group",
            description: "A test group",
            owner_id: "ou_owner",
            owner_id_type: "open_id",
            avatar: "https://example.com/avatar.png",
            external: false,
            tenant_key: "tk_1",
            labels: ["label1"],
            chat_status: "normal",
          },
        ],
      },
    });

    const result = (await tool.execute("tc_3", { action: "list" })) as any;
    expect(result.details).toEqual({
      has_more: true,
      page_token: "next_page",
      items: [
        {
          chat_id: "oc_abc",
          name: "Test Group",
          description: "A test group",
          owner_id: "ou_owner",
          owner_id_type: "open_id",
          avatar: "https://example.com/avatar.png",
          external: false,
          tenant_key: "tk_1",
          labels: ["label1"],
          chat_status: "normal",
        },
      ],
    });
  });

  it("list action forwards pagination and sort params", async () => {
    const tool = registerAndGetTool();

    chatListMock.mockResolvedValueOnce({
      code: 0,
      data: { has_more: false, page_token: "", items: [] },
    });

    await tool.execute("tc_4", {
      action: "list",
      page_size: 20,
      page_token: "tok_abc",
      sort_type: "ByActiveTimeDesc",
      user_id_type: "union_id",
    });

    expect(chatListMock).toHaveBeenCalledWith({
      params: {
        page_size: 20,
        page_token: "tok_abc",
        sort_type: "ByActiveTimeDesc",
        user_id_type: "union_id",
      },
    });
  });

  it("list action handles API error", async () => {
    const tool = registerAndGetTool();

    chatListMock.mockResolvedValueOnce({
      code: 99999,
      msg: "permission denied",
    });

    const result = (await tool.execute("tc_5", { action: "list" })) as any;
    expect(result.details).toEqual({ error: "permission denied" });
  });

  it("members action returns error when chat_id is missing", async () => {
    const tool = registerAndGetTool();
    const result = (await tool.execute("tc_6", { action: "members" })) as any;
    expect(result.details).toEqual({ error: "chat_id is required for members action" });
  });

  it("info action returns error when chat_id is missing", async () => {
    const tool = registerAndGetTool();
    const result = (await tool.execute("tc_7", { action: "info" })) as any;
    expect(result.details).toEqual({ error: "chat_id is required for info action" });
  });

  it("uses agent's bound account for API calls", async () => {
    const tool = registerAndGetTool("jim");

    chatListMock.mockResolvedValueOnce({
      code: 0,
      data: { has_more: false, page_token: "", items: [] },
    });

    await tool.execute("tc_8", { action: "list" });

    // createFeishuClient should have been called with jim's account credentials
    expect(createFeishuClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "app_jim", appSecret: "secret_jim" }),
    );
  });

  it("explicit accountId overrides agent's default account", async () => {
    const tool = registerAndGetTool("jim");

    chatListMock.mockResolvedValueOnce({
      code: 0,
      data: { has_more: false, page_token: "", items: [] },
    });

    await tool.execute("tc_9", { action: "list", accountId: "default" });

    expect(createFeishuClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "app_default", appSecret: "secret_default" }),
    );
  });

  it("rejects execution when resolved account has chat tool disabled", async () => {
    const { api, resolveTool } = createToolFactoryHarness({
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            default: {
              appId: "app_default",
              appSecret: "secret_default",
              tools: { chat: true },
            },
            nochat: {
              appId: "app_nochat",
              appSecret: "secret_nochat",
              tools: { chat: false },
            },
          },
          tools: { chat: true },
        },
      },
    } as any);

    registerFeishuChatTools(api);
    const tool = resolveTool("feishu_chat", { agentAccountId: "nochat" });

    const result = (await tool.execute("tc_10", { action: "list" })) as any;
    expect(result.details).toEqual({
      error: expect.stringContaining("chat tool is disabled"),
    });
  });
});
