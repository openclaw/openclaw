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
        content: "hello markdown
hello div",
      }),
    );
  });
});

// Image message tests
describe('sendImageFeishu', () => {
  const mockImageClient = {
    im: {
      image: { create: vi.fn() },
      message: { create: vi.fn(), reply: vi.fn() },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateFeishuClient.mockReturnValue(mockImageClient);
  });

  it('should upload and send image', async () => {
    const { sendImageFeishu } = await import('./send.js');
    
    mockImageClient.im.image.create.mockResolvedValueOnce({
      code: 0, data: { image_key: 'img_test123' },
    });
    mockImageClient.im.message.create.mockResolvedValueOnce({
      code: 0, data: { message_id: 'om_img_123', create_time: '1234567890' },
    });

    const result = await sendImageFeishu({
      cfg: { feishu: { appId: 'test', appSecret: 'secret' } } as any,
      to: 'chat:test-id',
      imagePath: '/test/image.jpg',
    });

    expect(result.messageId).toBe('om_img_123');
    expect(mockImageClient.im.image.create).toHaveBeenCalled();
  });
});

