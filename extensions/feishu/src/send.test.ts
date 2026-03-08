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

  it("extracts text from plain_text and lark_md card elements", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_2",
            chat_id: "oc_2",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                elements: [
                  { tag: "plain_text", content: "plain text content" },
                  { tag: "lark_md", content: "lark md content" },
                ],
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({ cfg: {} as ClawdbotConfig, messageId: "om_2" });
    expect(result).toEqual(
      expect.objectContaining({ content: "plain text content\nlark md content" }),
    );
  });

  it("extracts header title from card", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_3",
            chat_id: "oc_3",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                header: { title: { content: "Alert Title", tag: "plain_text" } },
                elements: [{ tag: "markdown", content: "alert body" }],
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({ cfg: {} as ClawdbotConfig, messageId: "om_3" });
    expect(result).toEqual(expect.objectContaining({ content: "Alert Title\nalert body" }));
  });

  it("extracts text from note elements (recursive)", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_4",
            chat_id: "oc_4",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                elements: [
                  {
                    tag: "note",
                    elements: [{ tag: "plain_text", content: "note content" }],
                  },
                ],
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({ cfg: {} as ClawdbotConfig, messageId: "om_4" });
    expect(result).toEqual(expect.objectContaining({ content: "note content" }));
  });

  it("extracts text from column_set elements", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_5",
            chat_id: "oc_5",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                elements: [
                  {
                    tag: "column_set",
                    columns: [
                      { elements: [{ tag: "markdown", content: "col1" }] },
                      { elements: [{ tag: "markdown", content: "col2" }] },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({ cfg: {} as ClawdbotConfig, messageId: "om_5" });
    expect(result).toEqual(expect.objectContaining({ content: "col1\ncol2" }));
  });

  it("extracts text from schema 2.0 cards (body.elements)", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_6",
            chat_id: "oc_6",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                schema: "2.0",
                header: { title: { content: "Schema 2.0 Header", tag: "plain_text" } },
                body: {
                  elements: [{ tag: "markdown", content: "schema 2.0 body" }],
                },
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({ cfg: {} as ClawdbotConfig, messageId: "om_6" });
    expect(result).toEqual(
      expect.objectContaining({ content: "Schema 2.0 Header\nschema 2.0 body" }),
    );
  });

  it("extracts text from legacy post-format card (array-of-arrays content field)", async () => {
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
                title: "[critical] Alert Title",
                content: [
                  [
                    { tag: "text", text: "PSM:", style: ["bold"] },
                    { tag: "text", text: " my-service" },
                  ],
                  [
                    { tag: "a", href: "http://example.com", text: "view link" },
                    { tag: "at", user_id: "@_user_1", user_name: "Alice" },
                  ],
                  [{ tag: "code_block", language: "GO", text: "func main() {}" }],
                  // these tags have no readable text and should be skipped
                  [{ tag: "img", image_key: "img_xxx" }],
                  [{ tag: "emotion", emoji_type: "SMILE" }],
                  [{ tag: "hr" }],
                ],
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({ cfg: {} as ClawdbotConfig, messageId: "om_legacy" });
    expect(result?.content).toContain("[critical] Alert Title");
    expect(result?.content).toContain("PSM:");
    expect(result?.content).toContain("my-service");
    expect(result?.content).toContain("view link");
    expect(result?.content).toContain("Alice");
    expect(result?.content).toContain("func main()");
    // img / emotion / hr should not produce output
    expect(result?.content).not.toContain("img_xxx");
    expect(result?.content).not.toContain("SMILE");
  });

  it("returns [Interactive Card] placeholder when no text can be extracted", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_7",
            chat_id: "oc_7",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                elements: [{ tag: "image", img_key: "img_token" }],
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({ cfg: {} as ClawdbotConfig, messageId: "om_7" });
    expect(result).toEqual(expect.objectContaining({ content: "[Interactive Card]" }));
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
