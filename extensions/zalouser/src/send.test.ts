import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  sendDeliveredZalouser,
  sendImageZalouser,
  sendLinkZalouser,
  sendMessageZalouser,
  sendReactionZalouser,
  sendSeenZalouser,
  sendTypingZalouser,
} from "./send.js";
import {
  sendZaloDeliveredEvent,
  sendZaloLink,
  sendZaloReaction,
  sendZaloSeenEvent,
  sendZaloTextMessage,
  sendZaloTypingEvent,
} from "./zalo-js.js";

vi.mock("./zalo-js.js", () => ({
  sendZaloTextMessage: vi.fn(),
  sendZaloLink: vi.fn(),
  sendZaloTypingEvent: vi.fn(),
  sendZaloReaction: vi.fn(),
  sendZaloDeliveredEvent: vi.fn(),
  sendZaloSeenEvent: vi.fn(),
}));

const mockSendText = vi.mocked(sendZaloTextMessage);
const mockSendLink = vi.mocked(sendZaloLink);
const mockSendTyping = vi.mocked(sendZaloTypingEvent);
const mockSendReaction = vi.mocked(sendZaloReaction);
const mockSendDelivered = vi.mocked(sendZaloDeliveredEvent);
const mockSendSeen = vi.mocked(sendZaloSeenEvent);

describe("zalouser send helpers", () => {
  beforeEach(() => {
    mockSendText.mockReset();
    mockSendLink.mockReset();
    mockSendTyping.mockReset();
    mockSendReaction.mockReset();
    mockSendDelivered.mockReset();
    mockSendSeen.mockReset();
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

  it("delegates typing helper to JS transport", async () => {
    await sendTypingZalouser("thread-4", { profile: "p4", isGroup: true });

    expect(mockSendTyping).toHaveBeenCalledWith("thread-4", {
      profile: "p4",
      isGroup: true,
    });
  });

  it("delegates reaction helper to JS transport", async () => {
    mockSendReaction.mockResolvedValueOnce({ ok: true });

    const result = await sendReactionZalouser({
      threadId: "thread-5",
      profile: "p5",
      isGroup: true,
      msgId: "100",
      cliMsgId: "200",
      emoji: "👍",
    });

    expect(mockSendReaction).toHaveBeenCalledWith({
      profile: "p5",
      threadId: "thread-5",
      isGroup: true,
      msgId: "100",
      cliMsgId: "200",
      emoji: "👍",
      remove: undefined,
    });
    expect(result).toEqual({ ok: true, error: undefined });
  });

  it("delegates delivered+seen helpers to JS transport", async () => {
    mockSendDelivered.mockResolvedValueOnce();
    mockSendSeen.mockResolvedValueOnce();

    const message = {
      msgId: "100",
      cliMsgId: "200",
      uidFrom: "1",
      idTo: "2",
      msgType: "webchat",
      st: 1,
      at: 0,
      cmd: 0,
      ts: "123",
    };

    await sendDeliveredZalouser({
      threadId: "thread-6",
      profile: "p6",
      isGroup: true,
      message,
      isSeen: false,
    });
    await sendSeenZalouser({ threadId: "thread-6", profile: "p6", isGroup: true, message });

    expect(mockSendDelivered).toHaveBeenCalledWith({
      threadId: "thread-6",
      profile: "p6",
      isGroup: true,
      message,
      isSeen: false,
    });
    expect(mockSendSeen).toHaveBeenCalledWith({
      threadId: "thread-6",
      profile: "p6",
      isGroup: true,
      message,
    });
  });
});
