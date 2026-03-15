import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerFeishuChatTools } from "./chat.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const chatGetMock = vi.hoisted(() => vi.fn());
const chatMembersGetMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

describe("registerFeishuChatTools", () => {
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
    const { api, resolveTool } = createToolFactoryHarness({
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            main: {
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { chat: true },
            },
          },
        },
      },
    } as any);

    registerFeishuChatTools(api);
    const tool = resolveTool("feishu_chat");

    chatGetMock.mockResolvedValueOnce({
      code: 0,
      data: { name: "group name", user_count: 3 },
    });
    const infoResult = (await tool.execute("tc_1", {
      action: "info",
      chat_id: "oc_1",
    })) as { details: unknown };
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
    })) as { details: unknown };
    expect(membersResult.details).toEqual(
      expect.objectContaining({
        chat_id: "oc_1",
        members: [expect.objectContaining({ member_id: "ou_1", name: "member1" })],
      }),
    );
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

  it("registers without resolving SecretRef-backed account config", () => {
    const registerTool = vi.fn();

    expect(() =>
      registerFeishuChatTools({
        config: {
          channels: {
            feishu: {
              enabled: true,
              accounts: {
                main: {
                  appId: { source: "file", provider: "default", id: "path/to/app-id" },
                  appSecret: { source: "file", provider: "default", id: "path/to/app-secret" },
                  tools: { chat: true },
                },
              },
            },
          },
        } as any,
        logger: { debug: vi.fn(), info: vi.fn() } as any,
        registerTool,
      } as any),
    ).not.toThrow();

    expect(registerTool).toHaveBeenCalledTimes(1);
  });
});
