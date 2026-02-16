import { describe, it, expect, vi, beforeEach } from "vitest";
import { whatsappPlugin } from "./channel.js";

// Mock runtime
const mockSendMessageWhatsApp = vi.fn().mockResolvedValue({ messageId: "123", toJid: "123@s.whatsapp.net" });

vi.mock("./runtime.js", () => ({
  getWhatsAppRuntime: () => ({
    channel: {
      text: { chunkText: (t: string) => [t] },
      whatsapp: {
        sendMessageWhatsApp: mockSendMessageWhatsApp,
        createLoginTool: vi.fn(),
      },
    },
    logging: { shouldLogVerbose: () => false },
  }),
}));

describe("whatsappPlugin.outbound.sendText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes linkPreview option to sendMessageWhatsApp", async () => {
    await whatsappPlugin.outbound.sendText({
      to: "1234567890",
      text: "http://example.com",
      // @ts-expect-error - injecting extra param as per runtime behavior
      linkPreview: false,
    });

    expect(mockSendMessageWhatsApp).toHaveBeenCalledWith(
      "1234567890",
      "http://example.com",
      expect.objectContaining({
        linkPreview: false,
      })
    );
  });

  it("passes linkPreview=undefined when omitted", async () => {
    await whatsappPlugin.outbound.sendText({
      to: "1234567890",
      text: "hello",
    });

    expect(mockSendMessageWhatsApp).toHaveBeenCalledWith(
      "1234567890",
      "hello",
      expect.objectContaining({
        linkPreview: undefined,
      })
    );
  });
});
