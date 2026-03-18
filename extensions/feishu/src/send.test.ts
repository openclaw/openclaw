import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import {
  buildFeishuPostMessagePayload,
  buildStructuredCard,
  editMessageFeishu,
  getMessageFeishu,
  listFeishuThreadMessages,
  parseTextWithMentions,
  resolveFeishuCardTemplate,
} from "./send.js";

const {
  mockClientGet,
  mockClientList,
  mockClientPatch,
  mockCreateFeishuClient,
  mockResolveFeishuAccount,
} = vi.hoisted(() => ({
  mockClientGet: vi.fn(),
  mockClientList: vi.fn(),
  mockClientPatch: vi.fn(),
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

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      text: {
        resolveMarkdownTableMode: () => "preserve",
        convertMarkdownTables: (text: string) => text,
      },
    },
  }),
}));

describe("parseTextWithMentions", () => {
  it("returns a single md element for plain text without mentions", () => {
    const result = parseTextWithMentions("Hello world");
    expect(result).toEqual([{ tag: "md", text: "Hello world" }]);
  });

  it("parses a single mention at the start", () => {
    const result = parseTextWithMentions(
      '<at user_id="ou_123">Alice</at> hello!',
    );
    expect(result).toEqual([
      { tag: "at", user_id: "ou_123", user_name: "Alice" },
      { tag: "md", text: " hello!" },
    ]);
  });

  it("parses a single mention at the end", () => {
    const result = parseTextWithMentions(
      'hello <at user_id="ou_456">Bob</at>',
    );
    expect(result).toEqual([
      { tag: "md", text: "hello " },
      { tag: "at", user_id: "ou_456", user_name: "Bob" },
    ]);
  });

  it("parses multiple mentions", () => {
    const result = parseTextWithMentions(
      '<at user_id="ou_1">Alice</at> <at user_id="ou_2">Bob</at> hi',
    );
    expect(result).toEqual([
      { tag: "at", user_id: "ou_1", user_name: "Alice" },
      { tag: "md", text: " " },
      { tag: "at", user_id: "ou_2", user_name: "Bob" },
      { tag: "md", text: " hi" },
    ]);
  });

  it("handles @all mention", () => {
    const result = parseTextWithMentions(
      '<at user_id="all">Everyone</at> announcement',
    );
    expect(result).toEqual([
      { tag: "at", user_id: "all", user_name: "Everyone" },
      { tag: "md", text: " announcement" },
    ]);
  });

  it("handles mention with empty display name", () => {
    const result = parseTextWithMentions(
      '<at user_id="ou_789"></at> test',
    );
    expect(result).toEqual([
      { tag: "at", user_id: "ou_789" },
      { tag: "md", text: " test" },
    ]);
  });

  it("returns single md element for empty string", () => {
    const result = parseTextWithMentions("");
    expect(result).toEqual([{ tag: "md", text: "" }]);
  });

  it("is safe to call multiple times in sequence", () => {
    const first = parseTextWithMentions('<at user_id="ou_1">A</at> x');
    const second = parseTextWithMentions('<at user_id="ou_2">B</at> y');
    expect(first).toEqual([
      { tag: "at", user_id: "ou_1", user_name: "A" },
      { tag: "md", text: " x" },
    ]);
    expect(second).toEqual([
      { tag: "at", user_id: "ou_2", user_name: "B" },
      { tag: "md", text: " y" },
    ]);
  });
});

describe("buildFeishuPostMessagePayload", () => {
  it("produces post payload with correct structure for plain text", () => {
    const result = buildFeishuPostMessagePayload({ messageText: "plain text" });
    expect(result.msgType).toBe("post");
    const parsed = JSON.parse(result.content);
    expect(parsed.zh_cn.content).toEqual([
      [{ tag: "md", text: "plain text" }],
    ]);
  });

  it("does not parse at tags when hasMentions is not set", () => {
    const result = buildFeishuPostMessagePayload({
      messageText: '<at user_id="ou_123">Alice</at> Hello!',
    });
    const parsed = JSON.parse(result.content);
    // Without hasMentions, the <at> markup is kept as literal text in a single md element
    expect(parsed.zh_cn.content).toEqual([
      [{ tag: "md", text: '<at user_id="ou_123">Alice</at> Hello!' }],
    ]);
  });

  it("splits mentions into native at elements when hasMentions is true", () => {
    const result = buildFeishuPostMessagePayload({
      messageText: '<at user_id="ou_123">Alice</at> Hello!',
      hasMentions: true,
    });
    const parsed = JSON.parse(result.content);
    expect(parsed.zh_cn.content).toEqual([
      [
        { tag: "at", user_id: "ou_123", user_name: "Alice" },
        { tag: "md", text: " Hello!" },
      ],
    ]);
  });

  it("handles multiple mentions interleaved with text when hasMentions is true", () => {
    const result = buildFeishuPostMessagePayload({
      messageText:
        '<at user_id="ou_1">Alice</at> <at user_id="ou_2">Bob</at> check this',
      hasMentions: true,
    });
    const parsed = JSON.parse(result.content);
    expect(parsed.zh_cn.content).toEqual([
      [
        { tag: "at", user_id: "ou_1", user_name: "Alice" },
        { tag: "md", text: " " },
        { tag: "at", user_id: "ou_2", user_name: "Bob" },
        { tag: "md", text: " check this" },
      ],
    ]);
  });
});

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
          list: mockClientList,
          patch: mockClientPatch,
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

  it("reuses the same content parsing for thread history messages", async () => {
    mockClientList.mockResolvedValueOnce({
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
    });

    const result = await listFeishuThreadMessages({
      cfg: {} as ClawdbotConfig,
      threadId: "omt_1",
      rootMessageId: "om_root",
    });

    expect(result).toEqual([
      expect.objectContaining({
        messageId: "om_file",
        contentType: "file",
        content: "[file message]",
      }),
      expect.objectContaining({
        messageId: "om_card",
        contentType: "interactive",
        content: "hello from card 2.0",
      }),
    ]);
  });
});

describe("editMessageFeishu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveFeishuAccount.mockReturnValue({
      accountId: "default",
      configured: true,
    });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          patch: mockClientPatch,
        },
      },
    });
  });

  it("patches post content for text edits", async () => {
    mockClientPatch.mockResolvedValueOnce({ code: 0 });

    const result = await editMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_edit",
      text: "updated body",
    });

    expect(mockClientPatch).toHaveBeenCalledWith({
      path: { message_id: "om_edit" },
      data: {
        content: JSON.stringify({
          zh_cn: {
            content: [
              [
                {
                  tag: "md",
                  text: "updated body",
                },
              ],
            ],
          },
        }),
      },
    });
    expect(result).toEqual({ messageId: "om_edit", contentType: "post" });
  });

  it("patches interactive content for card edits", async () => {
    mockClientPatch.mockResolvedValueOnce({ code: 0 });

    const result = await editMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_card",
      card: { schema: "2.0" },
    });

    expect(mockClientPatch).toHaveBeenCalledWith({
      path: { message_id: "om_card" },
      data: {
        content: JSON.stringify({ schema: "2.0" }),
      },
    });
    expect(result).toEqual({ messageId: "om_card", contentType: "interactive" });
  });
});

describe("resolveFeishuCardTemplate", () => {
  it("accepts supported Feishu templates", () => {
    expect(resolveFeishuCardTemplate(" purple ")).toBe("purple");
  });

  it("drops unsupported free-form identity themes", () => {
    expect(resolveFeishuCardTemplate("space lobster")).toBeUndefined();
  });
});

describe("buildStructuredCard", () => {
  it("falls back to blue when the header template is unsupported", () => {
    const card = buildStructuredCard("hello", {
      header: {
        title: "Agent",
        template: "space lobster",
      },
    });

    expect(card).toEqual(
      expect.objectContaining({
        header: {
          title: { tag: "plain_text", content: "Agent" },
          template: "blue",
        },
      }),
    );
  });
});
