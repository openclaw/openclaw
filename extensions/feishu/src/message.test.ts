import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerFeishuMessageTools } from "./message.js";

const createFeishuToolClientMock = vi.hoisted(() => vi.fn());

vi.mock("./tool-account.js", () => ({
  createFeishuToolClient: createFeishuToolClientMock,
}));

function makeClient(overrides?: {
  formatPayload?: () => Promise<{ headers: Record<string, string> }>;
  request?: (opts: Record<string, unknown>) => Promise<unknown>;
}) {
  const formatPayload = vi.fn(
    overrides?.formatPayload ?? (() => Promise.resolve({ headers: { Authorization: "Bearer t" } })),
  );
  const request = vi.fn(
    overrides?.request ??
      (() =>
        Promise.resolve({
          code: 0,
          data: { has_more: false, page_token: "", items: [] },
        })),
  );
  return {
    domain: "https://open.feishu.cn",
    formatPayload,
    httpInstance: { request },
  };
}

const FEISHU_CONFIG = {
  channels: {
    feishu: {
      enabled: true,
      appId: "app_id",
      appSecret: "app_secret",
      tools: { message: true },
    },
  },
} as any;

describe("registerFeishuMessageTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function registerAndGetTool(configOverride?: any) {
    const registerTool = vi.fn();
    registerFeishuMessageTools({
      config: configOverride ?? FEISHU_CONFIG,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);

    expect(registerTool).toHaveBeenCalledTimes(1);
    const factory = registerTool.mock.calls[0]?.[0];
    const ctx = {
      requesterSenderId: "ou_test_user",
      agentAccountId: "default",
      messageChannel: "feishu",
    };
    const tool = typeof factory === "function" ? factory(ctx) : factory;
    return tool;
  }

  it("registers feishu_message tool", () => {
    const registerTool = vi.fn();
    registerFeishuMessageTools({
      config: FEISHU_CONFIG,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);
    expect(registerTool).toHaveBeenCalledTimes(1);
  });

  it("list action uses tenant_access_token (app-level)", async () => {
    const client = makeClient({
      request: () =>
        Promise.resolve({
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
        }),
    });
    createFeishuToolClientMock.mockReturnValue(client);

    const tool = registerAndGetTool();
    const result = await tool.execute("tc_1", { action: "list", chat_id: "oc_1" });

    expect(result.details).toEqual(
      expect.objectContaining({
        container_id_type: "chat",
        container_id: "oc_1",
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

    // Verify request used the default tenant token (from formatPayload), NOT a user token override
    const requestCall = (client.httpInstance.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(requestCall.headers.Authorization).toBe("Bearer t");
  });

  it("list action passes start_time and end_time as query params", async () => {
    const client = makeClient();
    createFeishuToolClientMock.mockReturnValue(client);

    const tool = registerAndGetTool();
    await tool.execute("tc_3", {
      action: "list",
      chat_id: "oc_1",
      start_time: "1700000000",
      end_time: "1700086400",
      sort_type: "ByCreateTimeDesc",
    });

    const requestCall = (client.httpInstance.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(requestCall.params).toEqual(
      expect.objectContaining({
        container_id_type: "chat",
        container_id: "oc_1",
        start_time: "1700000000",
        end_time: "1700086400",
        sort_type: "ByCreateTimeDesc",
        page_size: "20",
      }),
    );
  });

  it("list action converts date strings to epoch seconds", async () => {
    const client = makeClient();
    createFeishuToolClientMock.mockReturnValue(client);

    const tool = registerAndGetTool();
    await tool.execute("tc_date", {
      action: "list",
      chat_id: "oc_1",
      start_time: "2026-03-01",
      end_time: "2026-03-01",
    });

    const requestCall = (client.httpInstance.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // 2026-03-01 00:00:00 CST = 2026-02-28 16:00:00 UTC = 1772294400
    expect(requestCall.params.start_time).toBe("1772294400");
    // 2026-03-01 23:59:59 CST = 2026-03-01 15:59:59 UTC = 1772380799
    expect(requestCall.params.end_time).toBe("1772380799");
  });

  it("list action passes ISO datetime with timezone as epoch seconds", async () => {
    const client = makeClient();
    createFeishuToolClientMock.mockReturnValue(client);

    const tool = registerAndGetTool();
    await tool.execute("tc_iso", {
      action: "list",
      chat_id: "oc_1",
      start_time: "2026-03-01T09:00:00+08:00",
      end_time: "2026-03-01T18:00:00+08:00",
    });

    const requestCall = (client.httpInstance.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // 2026-03-01T09:00:00+08:00 = 2026-03-01T01:00:00Z = 1772326800
    expect(requestCall.params.start_time).toBe("1772326800");
    // 2026-03-01T18:00:00+08:00 = 2026-03-01T10:00:00Z = 1772359200
    expect(requestCall.params.end_time).toBe("1772359200");
  });

  it("list action passes raw epoch seconds unchanged", async () => {
    const client = makeClient();
    createFeishuToolClientMock.mockReturnValue(client);

    const tool = registerAndGetTool();
    await tool.execute("tc_raw", {
      action: "list",
      chat_id: "oc_1",
      start_time: "1700000000",
      end_time: "1700086400",
    });

    const requestCall = (client.httpInstance.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(requestCall.params.start_time).toBe("1700000000");
    expect(requestCall.params.end_time).toBe("1700086400");
  });

  it("get action fetches single message", async () => {
    const client = makeClient({
      request: () =>
        Promise.resolve({
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
        }),
    });
    createFeishuToolClientMock.mockReturnValue(client);

    const tool = registerAndGetTool();
    const result = await tool.execute("tc_4", { action: "get", message_id: "om_2" });
    expect(result.details).toEqual(
      expect.objectContaining({
        message_id: "om_2",
        msg_type: "text",
        body: { content: '{"text":"world"}' },
      }),
    );
  });

  it("list with container_id_type=thread uses thread_id", async () => {
    const client = makeClient({
      request: () =>
        Promise.resolve({
          code: 0,
          data: {
            has_more: false,
            page_token: "",
            items: [
              {
                message_id: "om_reply",
                msg_type: "text",
                create_time: "1700000010",
                chat_id: "oc_1",
                thread_id: "omt_abc",
                root_id: "om_root",
                parent_id: "om_root",
                sender: { id: "ou_1", id_type: "open_id", sender_type: "user" },
                body: { content: '{"text":"thread reply"}' },
              },
            ],
          },
        }),
    });
    createFeishuToolClientMock.mockReturnValue(client);

    const tool = registerAndGetTool();
    const result = await tool.execute("tc_thread", {
      action: "list",
      container_id_type: "thread",
      thread_id: "omt_abc",
    });

    expect(result.details).toEqual(
      expect.objectContaining({
        container_id_type: "thread",
        container_id: "omt_abc",
      }),
    );
    expect(result.details.items[0]).toEqual(
      expect.objectContaining({
        thread_id: "omt_abc",
        root_id: "om_root",
        parent_id: "om_root",
      }),
    );

    const requestCall = (client.httpInstance.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(requestCall.params.container_id_type).toBe("thread");
    expect(requestCall.params.container_id).toBe("omt_abc");
    // Thread queries must not include time range params
    expect(requestCall.params.start_time).toBeUndefined();
    expect(requestCall.params.end_time).toBeUndefined();
  });

  it("auto-expands threads when listing chat messages", async () => {
    let callCount = 0;
    const client = makeClient({
      request: () => {
        callCount++;
        if (callCount === 1) {
          // First call: chat messages with a thread root
          return Promise.resolve({
            code: 0,
            data: {
              has_more: false,
              page_token: "",
              items: [
                {
                  message_id: "om_normal",
                  msg_type: "text",
                  create_time: "1700000000",
                  chat_id: "oc_1",
                  sender: { id: "ou_1", id_type: "open_id", sender_type: "user" },
                  body: { content: '{"text":"normal msg"}' },
                },
                {
                  message_id: "om_thread_root",
                  msg_type: "text",
                  create_time: "1700000001",
                  chat_id: "oc_1",
                  thread_id: "omt_t1",
                  sender: { id: "ou_2", id_type: "open_id", sender_type: "user" },
                  body: { content: '{"text":"thread root"}' },
                },
              ],
            },
          });
        }
        // Second call: thread replies
        return Promise.resolve({
          code: 0,
          data: {
            has_more: false,
            page_token: "",
            items: [
              {
                message_id: "om_reply_1",
                msg_type: "text",
                create_time: "1700000010",
                chat_id: "oc_1",
                thread_id: "omt_t1",
                root_id: "om_thread_root",
                parent_id: "om_thread_root",
                sender: { id: "ou_3", id_type: "open_id", sender_type: "user" },
                body: { content: '{"text":"reply in thread"}' },
              },
            ],
          },
        });
      },
    });
    createFeishuToolClientMock.mockReturnValue(client);

    const tool = registerAndGetTool();
    const result = await tool.execute("tc_expand", { action: "list", chat_id: "oc_1" });

    // Normal message should NOT have thread_replies
    expect(result.details.items[0].thread_replies).toBeUndefined();

    // Thread root should have thread_replies populated
    const threadRoot = result.details.items[1];
    expect(threadRoot.thread_id).toBe("omt_t1");
    expect(threadRoot.thread_replies).toHaveLength(1);
    expect(threadRoot.thread_replies[0]).toEqual(
      expect.objectContaining({ message_id: "om_reply_1" }),
    );

    // Should have made 2 API calls: one for chat, one for thread
    expect(callCount).toBe(2);
  });

  it("skips thread expansion when expand_threads=false", async () => {
    let callCount = 0;
    const client = makeClient({
      request: () => {
        callCount++;
        return Promise.resolve({
          code: 0,
          data: {
            has_more: false,
            page_token: "",
            items: [
              {
                message_id: "om_root",
                msg_type: "text",
                create_time: "1700000000",
                chat_id: "oc_1",
                thread_id: "omt_t1",
                sender: { id: "ou_1", id_type: "open_id", sender_type: "user" },
                body: { content: '{"text":"root"}' },
              },
            ],
          },
        });
      },
    });
    createFeishuToolClientMock.mockReturnValue(client);

    const tool = registerAndGetTool();
    const result = await tool.execute("tc_no_expand", {
      action: "list",
      chat_id: "oc_1",
      expand_threads: false,
    });

    expect(result.details.items[0].thread_replies).toBeUndefined();
    // Only 1 API call — no thread expansion
    expect(callCount).toBe(1);
  });

  it("list with container_id_type=thread ignores start_time/end_time", async () => {
    const client = makeClient();
    createFeishuToolClientMock.mockReturnValue(client);

    const tool = registerAndGetTool();
    await tool.execute("tc_thread_time", {
      action: "list",
      container_id_type: "thread",
      thread_id: "omt_abc",
      start_time: "1700000000",
      end_time: "1700086400",
    });

    const requestCall = (client.httpInstance.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(requestCall.params.start_time).toBeUndefined();
    expect(requestCall.params.end_time).toBeUndefined();
  });

  it("returns error when thread_id missing for thread container type", async () => {
    const client = makeClient();
    createFeishuToolClientMock.mockReturnValue(client);

    const tool = registerAndGetTool();
    const result = await tool.execute("tc_no_thread", {
      action: "list",
      container_id_type: "thread",
    });
    expect(result.details.error).toContain("thread_id is required");
  });

  it("returns error when chat_id missing for list", async () => {
    const client = makeClient();
    createFeishuToolClientMock.mockReturnValue(client);

    const tool = registerAndGetTool();
    const result = await tool.execute("tc_5", { action: "list" });
    expect(result.details).toEqual({ error: "chat_id is required for list action" });
  });

  it("returns friendly error for code 230002 (bot not in chat)", async () => {
    const client = makeClient({
      request: () => Promise.resolve({ code: 230002, msg: "Bot/User can NOT be out of the chat." }),
    });
    createFeishuToolClientMock.mockReturnValue(client);

    const tool = registerAndGetTool();
    const result = await tool.execute("tc_6", { action: "list", chat_id: "oc_bad" });
    expect(result.details.error).toContain("BOT_NOT_IN_CHAT");
  });

  it("returns friendly error for permission denied (code 230027)", async () => {
    const client = makeClient({
      request: () =>
        Promise.reject({
          response: {
            status: 403,
            data: { code: 230027, msg: "Lack of necessary permissions" },
          },
        }),
    });
    createFeishuToolClientMock.mockReturnValue(client);

    const tool = registerAndGetTool();
    const result = await tool.execute("tc_8", { action: "list", chat_id: "oc_1" });
    expect(result.details.error).toContain("PERMISSION_DENIED");
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
