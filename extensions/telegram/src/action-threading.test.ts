import type { ChannelThreadingToolContext } from "openclaw/plugin-sdk/channel-contract";
import { describe, expect, it } from "vitest";
import { resolveTelegramAutoThreadId } from "./action-threading.js";

function createToolContext(
  overrides: Partial<ChannelThreadingToolContext> = {},
): ChannelThreadingToolContext {
  return {
    currentChannelId: "tg:group:-100123",
    currentThreadTs: "thread-1",
    replyToMode: "all",
    ...overrides,
  };
}

describe("resolveTelegramAutoThreadId", () => {
  it("matches chats across Telegram target formats", () => {
    expect(
      resolveTelegramAutoThreadId({
        to: "telegram:group:-100123",
        toolContext: createToolContext(),
      }),
    ).toBe("thread-1");

    expect(
      resolveTelegramAutoThreadId({
        to: "-100999:77",
        toolContext: createToolContext(),
      }),
    ).toBeUndefined();

    expect(
      resolveTelegramAutoThreadId({
        to: "-100123",
        toolContext: createToolContext({ currentChannelId: undefined }),
      }),
    ).toBeUndefined();
  });

  it("does not override an explicit target topic", () => {
    expect(
      resolveTelegramAutoThreadId({
        to: "telegram:group:-100123:topic:77",
        toolContext: createToolContext(),
      }),
    ).toBeUndefined();
  });
});
