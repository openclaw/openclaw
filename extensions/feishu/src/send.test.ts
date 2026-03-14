import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMessageFeishu } from "./send.js";

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

  it("extracts text from schema 2.0 cards (body.elements)", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_v2",
            chat_id: "oc_v2",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                body: {
                  elements: [
                    { tag: "markdown", content: "schema 2.0 text" },
                    { tag: "plain_text", content: "plain content" },
                  ],
                },
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_v2",
    });

    expect(result).toEqual(
      expect.objectContaining({
        messageId: "om_v2",
        contentType: "interactive",
        content: "schema 2.0 text\nplain content",
      }),
    );
  });

  it("extracts text from header, lark_md, and note elements", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_rich",
            chat_id: "oc_rich",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                elements: [
                  {
                    tag: "header",
                    title: { content: "Alert Title" },
                    subtitle: { content: "Sub" },
                  },
                  { tag: "lark_md", content: "lark md text" },
                  {
                    tag: "note",
                    elements: [{ tag: "plain_text", content: "note text" }],
                  },
                ],
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_rich",
    });

    expect(result).toEqual(
      expect.objectContaining({
        messageId: "om_rich",
        contentType: "interactive",
        content: "Alert Title\nSub\nlark md text\nnote text",
      }),
    );
  });

  it("extracts text from column_set elements", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_col",
            chat_id: "oc_col",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                elements: [
                  {
                    tag: "column_set",
                    columns: [
                      { elements: [{ tag: "markdown", content: "col1" }] },
                      { elements: [{ tag: "plain_text", content: "col2" }] },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_col",
    });

    expect(result).toEqual(
      expect.objectContaining({
        content: "col1\ncol2",
      }),
    );
  });

  it("extracts text from legacy rich-text content (array-of-arrays)", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_legacy",
            chat_id: "oc_legacy",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                title: "Card Title",
                content: [
                  [
                    { tag: "text", text: "hello " },
                    { tag: "a", text: "link" },
                    { tag: "at", user_name: "John" },
                  ],
                ],
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_legacy",
    });

    expect(result).toEqual(
      expect.objectContaining({
        content: "Card Title\nhello \nlink\n@John",
      }),
    );
  });

  it("handles deeply nested/wide elements without crashing (DFS stack overflow protection)", async () => {
    // Build a card with many nested column_sets, each with many columns/elements
    // This would cause unbounded stack growth without the stack.length guard
    const wideColumns = Array.from({ length: 300 }, (_, i) => ({
      elements: Array.from({ length: 20 }, (_, j) => ({
        tag: "markdown",
        content: `c${i}-e${j}`,
      })),
    }));
    const deepElements = Array.from({ length: 200 }, () => ({
      tag: "column_set",
      columns: wideColumns,
    }));

    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_dfs",
            chat_id: "oc_dfs",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({ elements: deepElements }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_dfs",
    });

    expect(result).not.toBeNull();
    expect(result!.contentType).toBe("interactive");
    // Should have extracted some text (truncated) but not crashed
    expect(typeof result!.content).toBe("string");
    expect(result!.content.length).toBeGreaterThan(0);
    expect(result!.content.length).toBeLessThanOrEqual(8100); // CARD_MAX_OUTPUT_CHARS + join overhead
  });

  it("returns [Interactive Card] for cards with no extractable text", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_empty",
            chat_id: "oc_empty",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({ elements: [{ tag: "img", img_key: "abc" }] }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_empty",
    });

    expect(result).toEqual(
      expect.objectContaining({
        content: "[Interactive Card]",
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
