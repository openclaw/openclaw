import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendImageZalouser, sendLinkZalouser, sendMessageZalouser } from "./send.js";
import { sendZaloLink, sendZaloTextMessage } from "./zalo-js.js";

vi.mock("./zalo-js.js", () => ({
  sendZaloTextMessage: vi.fn(),
  sendZaloLink: vi.fn(),
}));

const mockSendText = vi.mocked(sendZaloTextMessage);
const mockSendLink = vi.mocked(sendZaloLink);

describe("zalouser send helpers", () => {
  beforeEach(() => {
    mockSendText.mockReset();
    mockSendLink.mockReset();
  });

  it("delegates text send to JS transport", async () => {
    mockSendText.mockResolvedValueOnce({ ok: true, messageId: "mid-1" });

    const result = await sendMessageZalouser("thread-1", "hello", {
      profile: "default",
      isGroup: true,
    });

    expect(mockSendText).toHaveBeenCalledWith("thread-1", "hello", {
      profile: "default",
      isGroup: true,
    });
    expect(result).toEqual({ ok: true, messageId: "mid-1" });
  });

  it("maps image helper to media send", async () => {
    mockSendText.mockResolvedValueOnce({ ok: true, messageId: "mid-2" });

    await sendImageZalouser("thread-2", "https://example.com/a.png", {
      profile: "p2",
      caption: "cap",
      isGroup: false,
    });

    expect(mockSendText).toHaveBeenCalledWith("thread-2", "cap", {
      profile: "p2",
      caption: "cap",
      isGroup: false,
      mediaUrl: "https://example.com/a.png",
    });
  });

  it("delegates link helper to JS transport", async () => {
    mockSendLink.mockResolvedValueOnce({ ok: false, error: "boom" });

    const result = await sendLinkZalouser("thread-3", "https://openclaw.ai", {
      profile: "p3",
      isGroup: true,
    });

    expect(mockSendLink).toHaveBeenCalledWith("thread-3", "https://openclaw.ai", {
      profile: "p3",
      isGroup: true,
    });
    expect(result).toEqual({ ok: false, error: "boom" });
  });
});
