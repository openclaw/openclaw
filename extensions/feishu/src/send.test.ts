import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import {
  buildMarkdownCard,
  buildStructuredCard,
  editMessageFeishu,
  enrichMentionPlaceholders,
  getMessageFeishu,
  listFeishuThreadMessages,
  resolveFeishuCardTemplate,
  sendCardFeishu,
  sendMessageFeishu,
  shouldUseFeishuMarkdownCard,
} from "./send.js";

const {
  mockConvertMarkdownTables,
  mockClientGet,
  mockClientList,
  mockClientPatch,
  mockCreateFeishuClient,
  mockResolveMarkdownTableMode,
  mockResolveFeishuAccount,
  mockRuntimeConvertMarkdownTables,
  mockRuntimeResolveMarkdownTableMode,
} = vi.hoisted(() => ({
  mockConvertMarkdownTables: vi.fn((text: string) => text),
  mockClientGet: vi.fn(),
  mockClientList: vi.fn(),
  mockClientPatch: vi.fn(),
  mockCreateFeishuClient: vi.fn(),
  mockResolveMarkdownTableMode: vi.fn(() => "preserve"),
  mockResolveFeishuAccount: vi.fn(),
  mockRuntimeConvertMarkdownTables: vi.fn((text: string) => text),
  mockRuntimeResolveMarkdownTableMode: vi.fn(() => "preserve"),
}));

vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  resolveMarkdownTableMode: mockResolveMarkdownTableMode,
}));

vi.mock("openclaw/plugin-sdk/text-runtime", () => ({
  convertMarkdownTables: mockConvertMarkdownTables,
  stripInlineDirectiveTagsForDelivery: vi.fn((text: string) => ({
    text: text
      .replace(
        /\s*(?:\[\[\s*audio_as_voice\s*\]\]|\[\[\s*(?:reply_to_current|reply_to\s*:\s*[^\]\n]+)\s*\]\])\s*/gi,
        " ",
      )
      .trim(),
    changed: true,
  })),
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
        resolveMarkdownTableMode: mockRuntimeResolveMarkdownTableMode,
        convertMarkdownTables: mockRuntimeConvertMarkdownTables,
      },
    },
  }),
}));

describe("getMessageFeishu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveMarkdownTableMode.mockReturnValue("preserve");
    mockConvertMarkdownTables.mockImplementation((text: string) => text);
    mockRuntimeResolveMarkdownTableMode.mockReturnValue("preserve");
    mockRuntimeConvertMarkdownTables.mockImplementation((text: string) => text);
    mockResolveFeishuAccount.mockReturnValue({
      accountId: "default",
      configured: true,
    });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          create: vi.fn(),
          get: mockClientGet,
          list: mockClientList,
          patch: mockClientPatch,
        },
      },
    });
  });

  it("sends text without requiring Feishu runtime text helpers", async () => {
    mockRuntimeResolveMarkdownTableMode.mockImplementation(() => {
      throw new Error("Feishu runtime not initialized");
    });
    mockRuntimeConvertMarkdownTables.mockImplementation(() => {
      throw new Error("Feishu runtime not initialized");
    });
    mockClientPatch.mockResolvedValueOnce({ code: 0 });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          create: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "om_send" } }),
          reply: vi.fn(),
          get: mockClientGet,
          list: mockClientList,
          patch: mockClientPatch,
        },
      },
    });

    const result = await sendMessageFeishu({
      cfg: {} as ClawdbotConfig,
      to: "oc_send",
      text: "hello",
    });

    expect(mockResolveMarkdownTableMode).toHaveBeenCalledWith({
      cfg: {},
      channel: "feishu",
    });
    expect(mockConvertMarkdownTables).toHaveBeenCalledWith("hello", "preserve");
    expect(result).toEqual({ messageId: "om_send", chatId: "oc_send" });
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

describe("sendMessageFeishu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveFeishuAccount.mockImplementation(
      ({ accountId }: { accountId?: string }) =>
        ({
          accountId: accountId ?? "default",
          configured: true,
          config: {},
        }) as never,
    );
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          get: mockClientGet,
          list: mockClientList,
          patch: mockClientPatch,
          create: vi.fn(),
          reply: vi.fn(),
        },
      },
    });
  });

  it("routes text sends through interactive cards when renderMode=card", async () => {
    const create = vi.fn().mockResolvedValue({
      code: 0,
      data: { message_id: "om_card" },
    });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          create,
          reply: vi.fn(),
        },
      },
    });
    mockResolveFeishuAccount.mockImplementation(
      ({ accountId }: { accountId?: string }) =>
        ({
          accountId: accountId ?? "default",
          configured: true,
          appId: "cli_main",
          appSecret: "secret_main",
          config: { renderMode: "card" },
        }) as never,
    );

    const result = await sendMessageFeishu({
      cfg: {
        channels: {
          feishu: {
            renderMode: "card",
          },
        },
      } as ClawdbotConfig,
      to: "chat:oc_group_1",
      text: "hello",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          msg_type: "interactive",
        }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({ messageId: "om_card" }));
  });

  it("strips inline reply tags before sending post text", async () => {
    const create = vi.fn().mockResolvedValue({
      code: 0,
      data: { message_id: "om_post" },
    });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          create,
          reply: vi.fn(),
        },
      },
    });

    await sendMessageFeishu({
      cfg: {} as ClawdbotConfig,
      to: "chat:oc_group_1",
      text: "[[reply_to_current]] hello",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: JSON.stringify({
            zh_cn: {
              content: [[{ tag: "md", text: "hello" }]],
            },
          }),
        }),
      }),
    );
  });
});

describe("shouldUseFeishuMarkdownCard", () => {
  it("detects fenced code blocks and tables", () => {
    expect(shouldUseFeishuMarkdownCard("```ts\nconst x = 1\n```")).toBe(true);
    expect(shouldUseFeishuMarkdownCard("| a | b |\n| - | - |")).toBe(true);
    expect(shouldUseFeishuMarkdownCard("plain text")).toBe(false);
  });
});

describe("sendCardFeishu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveFeishuAccount.mockReturnValue({
      accountId: "default",
      configured: true,
      appId: "cli_main",
      appSecret: "secret_main",
      config: {},
    });
  });

  it("normalizes text-style mentions in raw interactive card payloads before sending", async () => {
    const create = vi.fn().mockResolvedValue({
      code: 0,
      data: { message_id: "om_card_raw" },
    });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          create,
          reply: vi.fn(),
        },
      },
    });

    const result = await sendCardFeishu({
      cfg: {} as ClawdbotConfig,
      to: "chat:oc_group_1",
      card: {
        schema: "2.0",
        body: {
          elements: [{ tag: "markdown", content: '<at user_id="ou_123">Emma</at> hello' }],
        },
      },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          msg_type: "interactive",
          content: JSON.stringify({
            schema: "2.0",
            body: {
              elements: [{ tag: "markdown", content: "<at id=ou_123></at> hello" }],
            },
          }),
        }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({ messageId: "om_card_raw" }));
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
    mockRuntimeResolveMarkdownTableMode.mockImplementation(() => {
      throw new Error("Feishu runtime not initialized");
    });
    mockRuntimeConvertMarkdownTables.mockImplementation(() => {
      throw new Error("Feishu runtime not initialized");
    });
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

  it("normalizes text-style mentions in raw card edits before patching", async () => {
    mockClientPatch.mockResolvedValueOnce({ code: 0 });

    const result = await editMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_card_raw_mentions",
      card: {
        schema: "2.0",
        body: {
          elements: [{ tag: "markdown", content: '<at user_id="ou_123">Emma</at> hello' }],
        },
      },
    });

    expect(mockClientPatch).toHaveBeenCalledWith({
      path: { message_id: "om_card_raw_mentions" },
      data: {
        content: JSON.stringify({
          schema: "2.0",
          body: {
            elements: [{ tag: "markdown", content: "<at id=ou_123></at> hello" }],
          },
        }),
      },
    });
    expect(result).toEqual({ messageId: "om_card_raw_mentions", contentType: "interactive" });
  });

  it("patches interactive content for text edits when renderMode=card", async () => {
    mockClientPatch.mockResolvedValueOnce({ code: 0 });
    mockResolveFeishuAccount.mockReturnValue({
      accountId: "default",
      configured: true,
      config: { renderMode: "card" },
    });

    const result = await editMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_edit_card",
      text: "updated body",
    });

    expect(mockClientPatch).toHaveBeenCalledWith({
      path: { message_id: "om_edit_card" },
      data: {
        content: JSON.stringify({
          schema: "2.0",
          config: {
            width_mode: "fill",
          },
          body: {
            elements: [{ tag: "markdown", content: "updated body" }],
          },
        }),
      },
    });
    expect(result).toEqual({ messageId: "om_edit_card", contentType: "interactive" });
  });

  it("normalizes text-style mentions before patching card markdown content", async () => {
    mockClientPatch.mockResolvedValueOnce({ code: 0 });
    mockResolveFeishuAccount.mockReturnValue({
      accountId: "default",
      configured: true,
      config: { renderMode: "card" },
    });

    const result = await editMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_edit_card_mentions",
      text: '<at user_id="ou_123">Emma</at> updated body',
    });

    expect(mockClientPatch).toHaveBeenCalledWith({
      path: { message_id: "om_edit_card_mentions" },
      data: {
        content: JSON.stringify({
          schema: "2.0",
          config: {
            width_mode: "fill",
          },
          body: {
            elements: [{ tag: "markdown", content: "<at id=ou_123></at> updated body" }],
          },
        }),
      },
    });
    expect(result).toEqual({ messageId: "om_edit_card_mentions", contentType: "interactive" });
  });

  it("patches interactive content for text edits in auto mode when markdown needs cards", async () => {
    mockClientPatch.mockResolvedValueOnce({ code: 0 });
    mockResolveFeishuAccount.mockReturnValue({
      accountId: "default",
      configured: true,
      config: { renderMode: "auto" },
    });

    const result = await editMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_edit_auto",
      text: "| a | b |\n| - | - |",
    });

    expect(mockClientPatch).toHaveBeenCalledWith({
      path: { message_id: "om_edit_auto" },
      data: {
        content: JSON.stringify({
          schema: "2.0",
          config: {
            width_mode: "fill",
          },
          body: {
            elements: [{ tag: "markdown", content: "| a | b |\n| - | - |" }],
          },
        }),
      },
    });
    expect(result).toEqual({ messageId: "om_edit_auto", contentType: "interactive" });
  });

  it("strips inline reply tags before patching text content", async () => {
    mockClientPatch.mockResolvedValueOnce({ code: 0 });

    await editMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_edit_strip_tag",
      text: "[[reply_to_current]] updated body",
    });

    expect(mockClientPatch).toHaveBeenCalledWith({
      path: { message_id: "om_edit_strip_tag" },
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
  it("uses schema-2.0 width config instead of legacy wide screen mode", () => {
    const card = buildStructuredCard("hello") as {
      config: {
        width_mode?: string;
        enable_forward?: boolean;
        wide_screen_mode?: boolean;
      };
    };

    expect(card.config.width_mode).toBe("fill");
    expect(card.config.enable_forward).toBeUndefined();
    expect(card.config.wide_screen_mode).toBeUndefined();
  });

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

  it("normalizes text-style mentions in markdown body content", () => {
    const card = buildStructuredCard('<at user_id="ou_123">Emma</at> hello');

    expect(card).toEqual(
      expect.objectContaining({
        body: {
          elements: [{ tag: "markdown", content: "<at id=ou_123></at> hello" }],
        },
      }),
    );
  });

  it("strips inline reply tags from markdown body content", () => {
    const card = buildStructuredCard("[[reply_to_current]] hello");

    expect(card).toEqual(
      expect.objectContaining({
        body: {
          elements: [{ tag: "markdown", content: "hello" }],
        },
      }),
    );
  });

  it("renders thinking as a collapsible panel instead of blockquote markdown", () => {
    const card = buildStructuredCard("final answer", {
      thinkingTitle: "💭 Thinking",
      thinkingText: "first line\nsecond line",
      thinkingExpanded: false,
    });

    expect(card).toEqual(
      expect.objectContaining({
        body: {
          elements: [
            expect.objectContaining({
              tag: "collapsible_panel",
              expanded: false,
              header: {
                title: { tag: "plain_text", content: "💭 Thinking" },
              },
              elements: [
                {
                  tag: "markdown",
                  content: "first line\nsecond line",
                  element_id: "thinking_content",
                },
              ],
            }),
            { tag: "markdown", content: "final answer" },
          ],
        },
      }),
    );
  });
});

describe("buildMarkdownCard", () => {
  it("normalizes text-style mentions before building markdown cards", () => {
    const card = buildMarkdownCard('<at user_id="ou_123">Emma</at> hello');

    expect(card).toEqual({
      schema: "2.0",
      config: {
        width_mode: "fill",
      },
      body: {
        elements: [{ tag: "markdown", content: "<at id=ou_123></at> hello" }],
      },
    });
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

describe("buildMarkdownCard", () => {
  it("uses schema-2.0 width config instead of legacy wide screen mode", () => {
    const card = buildMarkdownCard("hello") as {
      config: {
        width_mode?: string;
        enable_forward?: boolean;
        wide_screen_mode?: boolean;
      };
    };

    expect(card.config.width_mode).toBe("fill");
    expect(card.config.enable_forward).toBeUndefined();
    expect(card.config.wide_screen_mode).toBeUndefined();
  });

  it("strips inline reply tags before building markdown cards", () => {
    const card = buildMarkdownCard("[[reply_to_current]] hello");

    expect(card).toEqual({
      schema: "2.0",
      config: {
        width_mode: "fill",
      },
      body: {
        elements: [{ tag: "markdown", content: "hello" }],
      },
    });
  });
});
