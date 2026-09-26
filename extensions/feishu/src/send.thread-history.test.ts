import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const { mockClientList, mockCreateFeishuClient, mockResolveFeishuAccount } = vi.hoisted(() => ({
  mockClientList: vi.fn(),
  mockCreateFeishuClient: vi.fn(),
  mockResolveFeishuAccount: vi.fn(),
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: mockResolveFeishuAccount,
  resolveFeishuRuntimeAccount: mockResolveFeishuAccount,
}));

let listFeishuThreadMessages: typeof import("./send.js").listFeishuThreadMessages;

beforeAll(async () => {
  ({ listFeishuThreadMessages } = await import("./send.js"));
});

afterAll(() => {
  vi.doUnmock("./client.js");
  vi.doUnmock("./accounts.js");
  vi.resetModules();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveFeishuAccount.mockReturnValue({
    accountId: "default",
    configured: true,
  });
  mockCreateFeishuClient.mockReturnValue({
    im: { message: { list: mockClientList } },
  });
});

describe("listFeishuThreadMessages", () => {
  it("reuses the same content parsing for thread history messages", async () => {
    const response = {
      code: 0,
      data: {
        items: [
          {
            message_id: "om_root",
            msg_type: "text",
            body: {
              content: JSON.stringify({ text: "root starter" }),
            },
          },
          {
            message_id: "om_card",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                body: {
                  elements: [{ tag: "markdown", content: "hello from card 2.0" }],
                },
              }),
            },
            sender: {
              id: "app_1",
              sender_type: "app",
            },
            create_time: "1710000000000",
          },
          {
            message_id: "om_post",
            msg_type: "post",
            body: {
              content: JSON.stringify({
                zh_cn: {
                  title: "Summary",
                  content: [[{ tag: "text", text: "Ready", style: ["bold"] }]],
                },
              }),
            },
            sender: { id: "ou_post", sender_type: "user" },
            create_time: "1710000000500",
          },
          {
            message_id: "om_file",
            msg_type: "file",
            body: {
              content: JSON.stringify({ file_key: "file_v3_123" }),
            },
            sender: {
              id: "ou_1",
              sender_type: "user",
            },
            create_time: "1710000001000",
          },
        ],
      },
    };
    const before = structuredClone(response);
    mockClientList.mockResolvedValueOnce(response);

    const result = await listFeishuThreadMessages({
      cfg: {} as ClawdbotConfig,
      threadId: "omt_1",
      rootMessageId: "om_root",
    });

    expect(mockClientList).toHaveBeenCalledWith({
      params: {
        container_id_type: "thread",
        container_id: "omt_1",
        sort_type: "ByCreateTimeDesc",
        page_size: 21,
        card_msg_content_type: "user_card_content",
      },
    });
    expect(response).toEqual(before);
    expect(result).toEqual([
      {
        messageId: "om_file",
        senderId: "ou_1",
        senderType: "user",
        contentType: "file",
        content: "[file message]",
        createTime: 1710000001000,
      },
      {
        messageId: "om_post",
        senderId: "ou_post",
        senderType: "user",
        contentType: "post",
        content: "Summary\n\n**Ready**",
        createTime: 1710000000500,
      },
      {
        messageId: "om_card",
        senderId: "app_1",
        senderType: "app",
        contentType: "interactive",
        content: "hello from card 2.0",
        createTime: 1710000000000,
      },
    ]);
  });

  it("does not partially parse malformed thread history create_time values", async () => {
    mockClientList.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_text",
            msg_type: "text",
            body: {
              content: JSON.stringify({ text: "partial time" }),
            },
            sender: {
              id: "ou_1",
              sender_type: "user",
            },
            create_time: "1710000000000ms",
          },
        ],
      },
    });

    const result = await listFeishuThreadMessages({
      cfg: {} as ClawdbotConfig,
      threadId: "omt_1",
      rootMessageId: "om_root",
    });

    expect(result).toEqual([
      {
        messageId: "om_text",
        senderId: "ou_1",
        senderType: "user",
        contentType: "text",
        content: "partial time",
        createTime: undefined,
      },
    ]);
  });

  it("fills thread history from continuation pages after excluding the current and root messages", async () => {
    mockClientList
      .mockResolvedValueOnce({
        code: 0,
        data: {
          has_more: true,
          page_token: "older-history",
          items: [
            { message_id: "om_current", body: { content: '{"text":"current"}' } },
            { message_id: "om_root", body: { content: '{"text":"root"}' } },
            { message_id: "om_newer", body: { content: '{"text":"newer"}' } },
          ],
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          has_more: false,
          items: [{ message_id: "om_older", body: { content: '{"text":"older"}' } }],
        },
      });

    const result = await listFeishuThreadMessages({
      cfg: {} as ClawdbotConfig,
      threadId: "omt_1",
      currentMessageId: "om_current",
      rootMessageId: "om_root",
      limit: 2,
    });

    expect(result.map((message) => message.messageId)).toEqual(["om_older", "om_newer"]);
    expect(mockClientList).toHaveBeenNthCalledWith(2, {
      params: {
        container_id_type: "thread",
        container_id: "omt_1",
        sort_type: "ByCreateTimeDesc",
        page_size: 3,
        page_token: "older-history",
        card_msg_content_type: "user_card_content",
      },
    });
  });

  it("reads thread history beyond the SDK's maximum single-page size", async () => {
    const pageOne = Array.from({ length: 50 }, (_value, index) => ({
      message_id: `om_${String(51 - index)}`,
      body: { content: JSON.stringify({ text: String(51 - index) }) },
    }));
    mockClientList
      .mockResolvedValueOnce({
        code: 0,
        data: { items: pageOne, has_more: true, page_token: "last-message" },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ message_id: "om_1", body: { content: '{"text":"1"}' } }],
          has_more: false,
        },
      });

    const result = await listFeishuThreadMessages({
      cfg: {} as ClawdbotConfig,
      threadId: "omt_1",
      limit: 51,
    });

    expect(result).toHaveLength(51);
    expect(result[0]?.messageId).toBe("om_1");
    expect(result.at(-1)?.messageId).toBe("om_51");
  });

  it("deduplicates overlapping continuation pages without consuming the history limit", async () => {
    mockClientList
      .mockResolvedValueOnce({
        code: 0,
        data: {
          has_more: true,
          page_token: "overlapping-page",
          items: [{ message_id: "om_newer", body: { content: '{"text":"newer"}' } }],
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            { message_id: "om_newer", body: { content: '{"text":"duplicate"}' } },
            { message_id: "om_older", body: { content: '{"text":"older"}' } },
          ],
        },
      });

    const result = await listFeishuThreadMessages({
      cfg: {} as ClawdbotConfig,
      threadId: "omt_1",
      limit: 2,
    });

    expect(result.map((message) => message.messageId)).toEqual(["om_older", "om_newer"]);
  });

  it.each([
    { name: "missing", firstToken: undefined, secondToken: undefined },
    { name: "repeated", firstToken: "same-page", secondToken: "same-page" },
  ])("rejects $name thread history continuation tokens", async ({ firstToken, secondToken }) => {
    mockClientList.mockResolvedValueOnce({
      code: 0,
      data: { items: [], has_more: true, ...(firstToken ? { page_token: firstToken } : {}) },
    });
    if (firstToken) {
      mockClientList.mockResolvedValueOnce({
        code: 0,
        data: { items: [], has_more: true, ...(secondToken ? { page_token: secondToken } : {}) },
      });
    }

    await expect(
      listFeishuThreadMessages({ cfg: {} as ClawdbotConfig, threadId: "omt_1" }),
    ).rejects.toThrow(
      `Feishu thread history pagination returned a ${firstToken ? "repeated" : "missing"} page token`,
    );
  });
});
