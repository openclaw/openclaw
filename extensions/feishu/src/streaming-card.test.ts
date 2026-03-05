import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/feishu", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { FeishuStreamingSession, mergeStreamingText } from "./streaming-card.js";

describe("mergeStreamingText", () => {
  it("prefers the latest full text when it already includes prior text", () => {
    expect(mergeStreamingText("hello", "hello world")).toBe("hello world");
  });

  it("keeps previous text when the next partial is empty or redundant", () => {
    expect(mergeStreamingText("hello", "")).toBe("hello");
    expect(mergeStreamingText("hello world", "hello")).toBe("hello world");
  });

  it("appends fragmented chunks without injecting newlines", () => {
    expect(mergeStreamingText("hello wor", "ld")).toBe("hello world");
    expect(mergeStreamingText("line1", "line2")).toBe("line1line2");
  });

  it("merges overlap between adjacent partial snapshots", () => {
    expect(mergeStreamingText("好的，让我", "让我再读取一遍")).toBe("好的，让我再读取一遍");
    expect(mergeStreamingText("revision_id: 552", "2，一点变化都没有")).toBe(
      "revision_id: 552，一点变化都没有",
    );
  });
});

describe("FeishuStreamingSession routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithSsrFGuardMock.mockReset();
  });

  it("prefers message.reply when reply target and root id both exist", async () => {
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: { json: async () => ({ code: 0, msg: "ok", tenant_access_token: "token" }) },
        release: async () => {},
      })
      .mockResolvedValueOnce({
        response: { json: async () => ({ code: 0, msg: "ok", data: { card_id: "card_1" } }) },
        release: async () => {},
      });

    const replyMock = vi.fn(async () => ({ code: 0, data: { message_id: "msg_reply" } }));
    const createMock = vi.fn(async () => ({ code: 0, data: { message_id: "msg_create" } }));

    const session = new FeishuStreamingSession(
      {
        im: {
          message: {
            reply: replyMock,
            create: createMock,
          },
        },
      } as never,
      {
        appId: "app",
        appSecret: "secret",
        domain: "feishu",
      },
    );

    await session.start("oc_chat", "chat_id", {
      replyToMessageId: "om_parent",
      replyInThread: true,
      rootId: "om_topic_root",
    });

    expect(replyMock).toHaveBeenCalledTimes(1);
    expect(replyMock).toHaveBeenCalledWith({
      path: { message_id: "om_parent" },
      data: expect.objectContaining({
        msg_type: "interactive",
        reply_in_thread: true,
      }),
    });
    expect(createMock).not.toHaveBeenCalled();
  });
});
