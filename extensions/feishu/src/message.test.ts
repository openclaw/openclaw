import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerFeishuMessageTools } from "./message.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

describe("registerFeishuMessageTools", () => {
  const messageListMock = vi.hoisted(() => vi.fn());
  const messageGetMock = vi.hoisted(() => vi.fn());

  beforeEach(() => {
    vi.clearAllMocks();
    createFeishuClientMock.mockReturnValue({
      im: {
        message: { list: messageListMock, get: messageGetMock },
      },
    });
  });

  it("registers feishu_message and handles list/get actions", async () => {
    const registerTool = vi.fn();
    registerFeishuMessageTools({
      config: {
        channels: {
          feishu: {
            enabled: true,
            appId: "app_id",
            appSecret: "app_secret",
            tools: { message: true },
          },
        },
      } as any,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);

    expect(registerTool).toHaveBeenCalledTimes(1);
    const tool = registerTool.mock.calls[0]?.[0];
    expect(tool?.name).toBe("feishu_message");

    messageListMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: false,
        page_token: "",
        items: [
          {
            message_id: "om_1",
            msg_type: "text",
            create_time: "1700000000",
            chat_id: "oc_1",
            sender: { id: "ou_1", id_type: "open_id", sender_type: "user" },
            body: { content: '{"text":"hello"}' },
          },
        ],
      },
    });
    const listResult = await tool.execute("tc_1", { action: "list", chat_id: "oc_1" });
    expect(listResult.details).toEqual(
      expect.objectContaining({
        chat_id: "oc_1",
        has_more: false,
        items: [
          expect.objectContaining({
            message_id: "om_1",
            msg_type: "text",
            sender: expect.objectContaining({ id: "ou_1" }),
          }),
        ],
      }),
    );

    messageGetMock.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_2",
            msg_type: "text",
            create_time: "1700000001",
            chat_id: "oc_1",
            sender: { id: "ou_2", id_type: "open_id", sender_type: "user" },
            body: { content: '{"text":"world"}' },
          },
        ],
      },
    });
    const getResult = await tool.execute("tc_2", { action: "get", message_id: "om_2" });
    expect(getResult.details).toEqual(
      expect.objectContaining({
        message_id: "om_2",
        msg_type: "text",
        body: { content: '{"text":"world"}' },
      }),
    );
  });

  it("returns error when chat_id missing for list", async () => {
    const registerTool = vi.fn();
    registerFeishuMessageTools({
      config: {
        channels: {
          feishu: {
            enabled: true,
            appId: "app_id",
            appSecret: "app_secret",
            tools: { message: true },
          },
        },
      } as any,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);

    const tool = registerTool.mock.calls[0]?.[0];
    const result = await tool.execute("tc_3", { action: "list" });
    expect(result.details).toEqual({ error: "chat_id is required for list action" });
  });

  it("skips registration when message tool is disabled", () => {
    const registerTool = vi.fn();
    registerFeishuMessageTools({
      config: {
        channels: {
          feishu: {
            enabled: true,
            appId: "app_id",
            appSecret: "app_secret",
            tools: { message: false },
          },
        },
      } as any,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);
    expect(registerTool).not.toHaveBeenCalled();
  });
});
