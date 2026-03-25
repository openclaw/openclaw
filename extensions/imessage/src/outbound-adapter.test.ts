import { beforeEach, describe, expect, it, vi } from "vitest";
import { imessageOutbound } from "./outbound-adapter.js";

describe("imessageOutbound", () => {
  const cfg = {
    channels: {
      imessage: {
        mediaMaxMb: 3,
      },
    },
  };

  const sendIMessage = vi.fn();

  beforeEach(() => {
    sendIMessage.mockReset();
  });

  it("forwards replyToId on direct text sends", async () => {
    sendIMessage.mockResolvedValueOnce({ messageId: "m-text" });

    const result = await imessageOutbound.sendText!({
      cfg,
      to: "chat_id:12",
      text: "hello",
      accountId: "default",
      replyToId: "reply-1",
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "chat_id:12",
      "hello",
      expect.objectContaining({
        accountId: "default",
        replyToId: "reply-1",
        maxBytes: 3 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({ channel: "imessage", messageId: "m-text" });
  });

  it("forwards mediaLocalRoots on direct media sends", async () => {
    sendIMessage.mockResolvedValueOnce({ messageId: "m-media-local" });

    const result = await imessageOutbound.sendMedia!({
      cfg,
      to: "chat_id:88",
      text: "caption",
      mediaUrl: "/tmp/workspace/pic.png",
      mediaLocalRoots: ["/tmp/workspace"],
      accountId: "acct-1",
      replyToId: "reply-2",
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "chat_id:88",
      "caption",
      expect.objectContaining({
        mediaUrl: "/tmp/workspace/pic.png",
        mediaLocalRoots: ["/tmp/workspace"],
        accountId: "acct-1",
        replyToId: "reply-2",
        maxBytes: 3 * 1024 * 1024,
      }),
    );
    expect(result).toEqual({ channel: "imessage", messageId: "m-media-local" });
  });
});
