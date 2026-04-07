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

  it("extracts text content from interactive card body.elements (schema 2.0)", async () => {
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
                header: { title: { content: "Header" } },
                body: {
                  elements: [
                    { tag: "markdown", content: "schema 2.0 markdown" },
                    { tag: "div", text: { content: "schema 2.0 div" } },
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
      messageId: "om_2",
    });

    expect(result).toEqual(
      expect.objectContaining({
        messageId: "om_2",
        chatId: "oc_2",
        contentType: "interactive",
        content: "Header\nschema 2.0 markdown\nschema 2.0 div",
      }),
    );
  });

  it("supports interactive_card alias", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_alias",
            chat_id: "oc_alias",
            msg_type: "interactive_card",
            body: {
              content: JSON.stringify({
                header: { title: { content: "Alias" } },
                elements: [{ tag: "markdown", content: "alias body" }],
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_alias",
    });

    expect(result).toEqual(
      expect.objectContaining({
        messageId: "om_alias",
        chatId: "oc_alias",
        contentType: "interactive_card",
        content: "Alias\nalias body",
      }),
    );
  });

  it("falls back to raw JSON when no readable text can be extracted", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_empty",
            chat_id: "oc_empty",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                header: {},
                elements: [{ tag: "div", text: { content: "   " } }],
              }),
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
        messageId: "om_empty",
        chatId: "oc_empty",
        contentType: "interactive",
        content: '{"header":{},"elements":[{"tag":"div","text":{"content":"   "}}]}',
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
