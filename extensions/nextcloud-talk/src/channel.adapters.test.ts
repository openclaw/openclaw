import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ send: vi.fn(async () => ({ ok: true as const })) }));
vi.mock("./send.js", () => ({
  sendReactionNextcloudTalk: hoisted.send,
  sendMessageNextcloudTalk: vi.fn(),
}));
const { nextcloudTalkMessageActions } = await import("./channel.adapters.js");
const cfg = {} as never;
const handle = (params: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  nextcloudTalkMessageActions.handleAction!({ action: "react", cfg, params, ...extra } as never);

describe("nextcloudTalkMessageActions", () => {
  beforeEach(() => hoisted.send.mockClear());
  afterEach(() => vi.clearAllMocks());

  it("advertises and gates the react action", () => {
    expect(nextcloudTalkMessageActions.describeMessageTool!({ cfg } as never)).toEqual({
      actions: ["react"],
    });
    expect(nextcloudTalkMessageActions.supportsAction!({ action: "react" } as never)).toBe(true);
    expect(nextcloudTalkMessageActions.supportsAction!({ action: "send" } as never)).toBe(false);
  });

  it("requires roomToken, messageId, and emoji", async () => {
    await expect(handle({ messageId: "m", emoji: "👍" })).rejects.toThrow(/room token/);
    await expect(handle({ roomToken: "r", emoji: "👍" })).rejects.toThrow(/messageId/);
    await expect(handle({ roomToken: "r", messageId: "m" })).rejects.toThrow(/emoji/);
  });

  it("normalizes inputs, forwards to send, and supports toolContext fallback", async () => {
    const result = await handle(
      { roomToken: " abc ", messageId: " m-1 ", emoji: " 👍 " },
      { accountId: "work" },
    );
    expect(hoisted.send).toHaveBeenCalledWith("abc", "m-1", "👍", {
      accountId: "work",
      cfg,
    });
    expect(result.details).toEqual({ messageId: "m-1", roomToken: "abc", reaction: "👍" });

    await handle(
      { emoji: "✅" },
      { toolContext: { currentChannelId: "room42", currentMessageId: "msg9" } },
    );
    expect(hoisted.send).toHaveBeenLastCalledWith("room42", "msg9", "✅", {
      accountId: undefined,
      cfg,
    });
  });
});
