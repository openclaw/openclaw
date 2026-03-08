import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMessageFeishu, parseInteractiveCardContent } from "./send.js";

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

describe("parseInteractiveCardContent", () => {
  it("extracts content from streaming card that has header and elements", () => {
    // A streaming card reference that also carries inline content should extract it
    const card = {
      type: "card",
      data: { card_id: "card_streaming_123" },
      header: { title: { content: "Stream Title" } },
      elements: [{ tag: "markdown", content: "streamed content" }],
    };
    expect(parseInteractiveCardContent(card)).toBe("Stream Title\nstreamed content");
  });

  it("returns [Streaming Card] for card_id reference with no inline content", () => {
    const card = { type: "card", data: { card_id: "card_streaming_456" } };
    expect(parseInteractiveCardContent(card)).toBe("[Streaming Card]");
  });

  it("falls back to non-empty locale when zh_cn is empty array", () => {
    const card = {
      i18n_elements: {
        zh_cn: [],
        en_us: [{ tag: "markdown", content: "english content" }],
      },
    };
    expect(parseInteractiveCardContent(card)).toBe("english content");
  });

  it("prefers zh_cn when it is a non-empty array", () => {
    const card = {
      i18n_elements: {
        zh_cn: [{ tag: "markdown", content: "中文内容" }],
        en_us: [{ tag: "markdown", content: "english content" }],
      },
    };
    expect(parseInteractiveCardContent(card)).toBe("中文内容");
  });

  it("extracts template variable values", () => {
    const card = {
      type: "template",
      data: {
        template_variable: {
          title: "Template Title",
          content: "Template Body",
          num: 42,
        },
      },
    };
    expect(parseInteractiveCardContent(card)).toBe("Template Title\nTemplate Body");
  });

  it("returns [Interactive Card] for null/undefined input", () => {
    expect(parseInteractiveCardContent(null)).toBe("[Interactive Card]");
    expect(parseInteractiveCardContent(undefined)).toBe("[Interactive Card]");
  });
});
