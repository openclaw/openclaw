import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerFeishuChatTools } from "./chat.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

describe("registerFeishuChatTools", () => {
  const chatGetMock = vi.hoisted(() => vi.fn());
  const chatSearchMock = vi.hoisted(() => vi.fn());
  const chatMembersGetMock = vi.hoisted(() => vi.fn());

  beforeEach(() => {
    vi.clearAllMocks();
    createFeishuClientMock.mockReturnValue({
      im: {
        chat: { get: chatGetMock, search: chatSearchMock },
        chatMembers: { get: chatMembersGetMock },
      },
    });
  });

  function registerTool() {
    const fn = vi.fn();
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
      registerTool: fn,
    } as any);
    expect(fn).toHaveBeenCalledTimes(1);
    return fn.mock.calls[0]?.[0];
  }

  it("handles info action", async () => {
    const tool = registerTool();
    chatGetMock.mockResolvedValueOnce({
      code: 0,
      data: { name: "group name", user_count: 3 },
    });
    const result = await tool.execute("tc_1", { action: "info", chat_id: "oc_1" });
    expect(result.details).toEqual(
      expect.objectContaining({ chat_id: "oc_1", name: "group name", user_count: 3 }),
    );
  });

  it("handles members action", async () => {
    const tool = registerTool();
    chatMembersGetMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: false,
        page_token: "",
        items: [{ member_id: "ou_1", name: "member1", member_id_type: "open_id" }],
      },
    });
    const result = await tool.execute("tc_2", { action: "members", chat_id: "oc_1" });
    expect(result.details).toEqual(
      expect.objectContaining({
        chat_id: "oc_1",
        members: [expect.objectContaining({ member_id: "ou_1", name: "member1" })],
      }),
    );
  });

  it("handles search action", async () => {
    const tool = registerTool();
    chatSearchMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: false,
        page_token: "",
        items: [
          {
            chat_id: "oc_100",
            name: "Project Alpha",
            description: "Alpha team chat",
            chat_type: "group",
            user_count: "5",
          },
        ],
      },
    });
    const result = await tool.execute("tc_3", { action: "search", query: "Alpha" });
    expect(result.details).toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            chat_id: "oc_100",
            name: "Project Alpha",
          }),
        ],
      }),
    );
  });

  it("returns error when search is called without query", async () => {
    const tool = registerTool();
    const result = await tool.execute("tc_4", { action: "search" });
    expect(result.details).toEqual({ error: "query is required for search action" });
  });

  it("returns error when info/members called without chat_id", async () => {
    const tool = registerTool();
    const r1 = await tool.execute("tc_5", { action: "info" });
    expect(r1.details).toEqual({ error: "chat_id is required for info action" });
    const r2 = await tool.execute("tc_6", { action: "members" });
    expect(r2.details).toEqual({ error: "chat_id is required for members action" });
  });

  it("skips registration when chat tool is disabled", () => {
    const fn = vi.fn();
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
      registerTool: fn,
    } as any);
    expect(fn).not.toHaveBeenCalled();
  });
});
