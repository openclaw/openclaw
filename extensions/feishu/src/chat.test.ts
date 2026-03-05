import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerFeishuChatTools } from "./chat.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

describe("registerFeishuChatTools", () => {
  const chatGetMock = vi.hoisted(() => vi.fn());
  const chatMembersGetMock = vi.hoisted(() => vi.fn());
  const messageListMock = vi.hoisted(() => vi.fn());

  beforeEach(() => {
    vi.clearAllMocks();
    createFeishuClientMock.mockReturnValue({
      im: {
        chat: { get: chatGetMock },
        chatMembers: { get: chatMembersGetMock },
        message: { list: messageListMock },
      },
    });
  });

  it("registers feishu_chat and handles info/members actions", async () => {
    const registerTool = vi.fn();
    registerFeishuChatTools({
      config: {
        channels: {
          feishu: {
            enabled: true,
            appId: "app_id",
            appSecret: "app_secret", // pragma: allowlist secret
            tools: { chat: true },
          },
        },
      } as any,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);

    expect(registerTool).toHaveBeenCalledTimes(1);
    const tool = registerTool.mock.calls[0]?.[0];
    expect(tool?.name).toBe("feishu_chat");

    chatGetMock.mockResolvedValueOnce({
      code: 0,
      data: { name: "group name", user_count: 3 },
    });
    const infoResult = await tool.execute("tc_1", { action: "info", chat_id: "oc_1" });
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
    const membersResult = await tool.execute("tc_2", { action: "members", chat_id: "oc_1" });
    expect(membersResult.details).toEqual(
      expect.objectContaining({
        chat_id: "oc_1",
        members: [expect.objectContaining({ member_id: "ou_1", name: "member1" })],
      }),
    );
  });

  it("handles history action — returns parsed messages", async () => {
    const registerTool = vi.fn();
    registerFeishuChatTools({
      config: {
        channels: {
          feishu: {
            enabled: true,
            appId: "app_id",
            appSecret: "app_secret",
            tools: { chat: true },
          },
        },
      } as any,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);

    const tool = registerTool.mock.calls[0]?.[0];

    messageListMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: true,
        page_token: "next_page",
        items: [
          {
            message_id: "om_1",
            msg_type: "text",
            create_time: "1709625600",
            sender: { id: "ou_1", id_type: "open_id", sender_type: "user" },
            body: { content: '{"text":"hello world"}' },
            deleted: false,
            updated: false,
          },
          {
            message_id: "om_2",
            msg_type: "post",
            create_time: "1709625700",
            sender: { id: "ou_2", id_type: "open_id", sender_type: "user" },
            body: {
              content: JSON.stringify({
                zh_cn: {
                  title: "Post Title",
                  content: [[{ tag: "text", text: "rich text line" }]],
                },
              }),
            },
            deleted: false,
            updated: false,
          },
          {
            message_id: "om_3",
            msg_type: "image",
            create_time: "1709625800",
            sender: { id: "ou_3", id_type: "open_id", sender_type: "user" },
            body: { content: '{"image_key":"img_xxx"}' },
            deleted: false,
            updated: false,
          },
        ],
      },
    });

    const result = await tool.execute("tc_hist", {
      action: "history",
      chat_id: "oc_1",
      page_size: 20,
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        chat_id: "oc_1",
        has_more: true,
        page_token: "next_page",
      }),
    );
    expect(result.details.messages).toHaveLength(3);
    expect(result.details.messages[0]).toEqual(
      expect.objectContaining({
        message_id: "om_1",
        content: "hello world",
        msg_type: "text",
      }),
    );
    expect(result.details.messages[1]).toEqual(
      expect.objectContaining({
        message_id: "om_2",
        content: "Post Title\nrich text line",
        msg_type: "post",
      }),
    );
    expect(result.details.messages[2]).toEqual(
      expect.objectContaining({
        message_id: "om_3",
        content: "[image]",
        msg_type: "image",
      }),
    );

    // Verify API was called with correct params
    expect(messageListMock).toHaveBeenCalledWith({
      params: expect.objectContaining({
        container_id_type: "chat",
        container_id: "oc_1",
        sort_type: "ByCreateTimeDesc",
        page_size: 20,
      }),
    });
  });

  it("handles history action — passes time range and sort params", async () => {
    const registerTool = vi.fn();
    registerFeishuChatTools({
      config: {
        channels: {
          feishu: {
            enabled: true,
            appId: "app_id",
            appSecret: "app_secret",
            tools: { chat: true },
          },
        },
      } as any,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);

    const tool = registerTool.mock.calls[0]?.[0];

    messageListMock.mockResolvedValueOnce({
      code: 0,
      data: { has_more: false, items: [] },
    });

    await tool.execute("tc_hist2", {
      action: "history",
      chat_id: "oc_1",
      start_time: "1709600000",
      end_time: "1709700000",
      sort_type: "ByCreateTimeAsc",
    });

    expect(messageListMock).toHaveBeenCalledWith({
      params: expect.objectContaining({
        container_id_type: "chat",
        container_id: "oc_1",
        start_time: "1709600000",
        end_time: "1709700000",
        sort_type: "ByCreateTimeAsc",
        page_size: 20,
      }),
    });
  });

  it("handles history action — API error propagates gracefully", async () => {
    const registerTool = vi.fn();
    registerFeishuChatTools({
      config: {
        channels: {
          feishu: {
            enabled: true,
            appId: "app_id",
            appSecret: "app_secret",
            tools: { chat: true },
          },
        },
      } as any,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);

    const tool = registerTool.mock.calls[0]?.[0];

    messageListMock.mockResolvedValueOnce({
      code: 99991,
      msg: "permission denied",
    });

    const result = await tool.execute("tc_hist3", {
      action: "history",
      chat_id: "oc_1",
    });

    expect(result.details).toEqual(expect.objectContaining({ error: "permission denied" }));
  });

  it("skips registration when chat tool is disabled", () => {
    const registerTool = vi.fn();
    registerFeishuChatTools({
      config: {
        channels: {
          feishu: {
            enabled: true,
            appId: "app_id",
            appSecret: "app_secret", // pragma: allowlist secret
            tools: { chat: false },
          },
        },
      } as any,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);
    expect(registerTool).not.toHaveBeenCalled();
  });
});
