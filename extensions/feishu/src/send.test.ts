import type { ClawdbotConfig } from "openclaw/plugin-sdk/compat";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enrichMentionPlaceholders, getMessageFeishu } from "./send.js";

const { mockClientGet, mockCreateFeishuClient, mockResolveFeishuAccount } = vi.hoisted(() => ({
  mockClientGet: vi.fn(),
  mockCreateFeishuClient: vi.fn(),
  mockResolveFeishuAccount: vi.fn(),
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: mockResolveFeishuAccount,
}));

describe("getMessageFeishu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveFeishuAccount.mockReturnValue({
      accountId: "default",
      configured: true,
    });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          get: mockClientGet,
        },
      },
    });
  });

  it("extracts text content from interactive card elements", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_1",
            chat_id: "oc_1",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                elements: [
                  { tag: "markdown", content: "hello markdown" },
                  { tag: "div", text: { content: "hello div" } },
                ],
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_1",
    });

    expect(result).toEqual(
      expect.objectContaining({
        messageId: "om_1",
        chatId: "oc_1",
        contentType: "interactive",
        content: "hello markdown\nhello div",
      }),
    );
  });

  it("extracts text content from post messages", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_post",
            chat_id: "oc_post",
            msg_type: "post",
            body: {
              content: JSON.stringify({
                zh_cn: {
                  title: "Summary",
                  content: [[{ tag: "text", text: "post body" }]],
                },
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_post",
    });

    expect(result).toEqual(
      expect.objectContaining({
        messageId: "om_post",
        chatId: "oc_post",
        contentType: "post",
        content: "Summary\n\npost body",
      }),
    );
  });

  it("returns text placeholder instead of raw JSON for unsupported message types", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_file",
            chat_id: "oc_file",
            msg_type: "file",
            body: {
              content: JSON.stringify({ file_key: "file_v3_123" }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_file",
    });

    expect(result).toEqual(
      expect.objectContaining({
        messageId: "om_file",
        chatId: "oc_file",
        contentType: "file",
        content: "[file message]",
      }),
    );
  });

  it("supports single-object response shape from Feishu API", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        message_id: "om_single",
        chat_id: "oc_single",
        msg_type: "text",
        body: {
          content: JSON.stringify({ text: "single payload" }),
        },
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_single",
    });

    expect(result).toEqual(
      expect.objectContaining({
        messageId: "om_single",
        chatId: "oc_single",
        contentType: "text",
        content: "single payload",
      }),
    );
  });
});

describe("enrichMentionPlaceholders", () => {
  it("replaces @_user_N placeholders with @name", () => {
    const content = "@_user_1 登陆了，@_user_2 也来了";
    const mentions = [
      { key: "@_user_1", name: "张三" },
      { key: "@_user_2", name: "李四" },
    ];
    expect(enrichMentionPlaceholders(content, mentions)).toBe("@张三 登陆了，@李四 也来了");
  });

  it("handles prefix collision: @_user_1 vs @_user_10", () => {
    const content = "@_user_1 和 @_user_10 都在";
    const mentions = [
      { key: "@_user_1", name: "Alice" },
      { key: "@_user_10", name: "Bob" },
    ];
    expect(enrichMentionPlaceholders(content, mentions)).toBe("@Alice 和 @Bob 都在");
  });

  it("returns content unchanged when mentions is empty or undefined", () => {
    expect(enrichMentionPlaceholders("hello @_user_1", undefined)).toBe("hello @_user_1");
    expect(enrichMentionPlaceholders("hello @_user_1", [])).toBe("hello @_user_1");
  });

  it("skips entries with missing key or name", () => {
    const content = "@_user_1 和 @_user_2 在";
    const mentions = [
      { key: "@_user_1", name: "Alice" },
      { key: "@_user_2", name: undefined },
      { key: undefined, name: "Ghost" },
    ] as Array<{ key?: string; name?: string }>;
    expect(enrichMentionPlaceholders(content, mentions)).toBe("@Alice 和 @_user_2 在");
  });

  it("trims whitespace-only keys and names", () => {
    const content = "@_user_1 hi";
    const mentions = [
      { key: "  ", name: "Alice" },
      { key: "@_user_1", name: "  " },
    ];
    expect(enrichMentionPlaceholders(content, mentions)).toBe("@_user_1 hi");
  });
});
