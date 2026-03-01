import type { ClawdbotConfig } from "openclaw/plugin-sdk";
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

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      feishu: {
        getMessageFeishu: async (params: {
          cfg: ClawdbotConfig;
          messageId: string;
          accountId?: string;
        }) => {
          const account = mockResolveFeishuAccount({
            cfg: params.cfg,
            accountId: params.accountId,
          });
          if (!account.configured)
            throw new Error(`Feishu account "${account.accountId}" not configured`);
          const client = mockCreateFeishuClient(account);
          const response = await client.im.message.get({ path: { message_id: params.messageId } });
          if (response.code !== 0) return null;
          const item = response.data?.items?.[0];
          if (!item) return null;
          let content = item.body?.content ?? "";
          try {
            const parsed = JSON.parse(content);
            if (item.msg_type === "text" && parsed.text) content = parsed.text;
            else if (item.msg_type === "interactive" && parsed.elements) {
              const texts: string[] = [];
              for (const el of parsed.elements) {
                if (el.tag === "div" && el.text?.content) texts.push(el.text.content);
                else if (el.tag === "markdown" && el.content) texts.push(el.content);
              }
              content = texts.join("\n") || "[Interactive Card]";
            }
          } catch {
            /* keep raw */
          }
          return {
            messageId: item.message_id ?? params.messageId,
            chatId: item.chat_id ?? "",
            senderId: item.sender?.id,
            senderOpenId: item.sender?.id_type === "open_id" ? item.sender?.id : undefined,
            senderType: item.sender?.sender_type,
            content,
            contentType: item.msg_type ?? "text",
            createTime: item.create_time ? parseInt(item.create_time, 10) : undefined,
          };
        },
      },
    },
  }),
  setFeishuRuntime: vi.fn(),
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
});
