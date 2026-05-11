import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTelegramPresenceIndicator,
  DEFAULT_PRESENCE_REACTION,
  DEFAULT_PRESENCE_WORKING_REACTION,
  PRESENCE_TYPING_INTERVAL_MS,
} from "./presence-indicator.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeDeps(overrides: Partial<Parameters<typeof createTelegramPresenceIndicator>[0]> = {}) {
  const setMessageReaction = vi.fn(async () => undefined);
  const sendChatAction = vi.fn(async () => undefined);
  const logger = vi.fn();
  return {
    setMessageReaction,
    sendChatAction,
    logger,
    deps: {
      setMessageReaction,
      sendChatAction,
      logger,
      ...overrides,
    },
  };
}

describe("createTelegramPresenceIndicator — lifecycle", () => {
  it("sets the received reaction on onMessageReceived", async () => {
    const { setMessageReaction, deps } = makeDeps();
    const presence = createTelegramPresenceIndicator(deps);
    await presence.onMessageReceived({ chatId: 100, messageId: 7 });
    expect(setMessageReaction).toHaveBeenCalledWith(100, 7, [
      { type: "emoji", emoji: DEFAULT_PRESENCE_REACTION },
    ]);
  });

  it("swaps to the working reaction on onProcessingStart", async () => {
    const { setMessageReaction, deps } = makeDeps();
    const presence = createTelegramPresenceIndicator(deps);
    await presence.onMessageReceived({ chatId: 100, messageId: 7 });
    await presence.onProcessingStart({ chatId: 100, messageId: 7 });
    expect(setMessageReaction).toHaveBeenNthCalledWith(2, 100, 7, [
      { type: "emoji", emoji: DEFAULT_PRESENCE_WORKING_REACTION },
    ]);
  });

  it("clears the reaction on onProcessingEnd", async () => {
    const { setMessageReaction, deps } = makeDeps();
    const presence = createTelegramPresenceIndicator(deps);
    await presence.onMessageReceived({ chatId: 100, messageId: 7 });
    await presence.onProcessingStart({ chatId: 100, messageId: 7 });
    await presence.onProcessingEnd({ chatId: 100, messageId: 7 });
    expect(setMessageReaction).toHaveBeenLastCalledWith(100, 7, []);
  });
});

describe("createTelegramPresenceIndicator — typing loop", () => {
  it("does NOT emit sendChatAction if processing finishes within debounce window", async () => {
    const { sendChatAction, deps } = makeDeps();
    const presence = createTelegramPresenceIndicator(deps);
    await presence.onProcessingStart({ chatId: 100, messageId: 7 });
    // Finish quickly — under 400ms debounce.
    await vi.advanceTimersByTimeAsync(100);
    await presence.onProcessingEnd({ chatId: 100, messageId: 7 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendChatAction).not.toHaveBeenCalled();
  });

  it("emits the first sendChatAction after the debounce, then every ~4s", async () => {
    const { sendChatAction, deps } = makeDeps();
    const presence = createTelegramPresenceIndicator(deps);
    await presence.onProcessingStart({ chatId: 100, messageId: 7, threadId: 42 });
    // Cross the 400ms debounce.
    await vi.advanceTimersByTimeAsync(400);
    expect(sendChatAction).toHaveBeenCalledTimes(1);
    expect(sendChatAction).toHaveBeenLastCalledWith(100, "typing", { message_thread_id: 42 });
    // Two interval ticks.
    await vi.advanceTimersByTimeAsync(PRESENCE_TYPING_INTERVAL_MS);
    expect(sendChatAction).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PRESENCE_TYPING_INTERVAL_MS);
    expect(sendChatAction).toHaveBeenCalledTimes(3);
    await presence.onProcessingEnd({ chatId: 100, messageId: 7, threadId: 42 });
    await vi.advanceTimersByTimeAsync(PRESENCE_TYPING_INTERVAL_MS * 3);
    // Stays at 3; loop stopped.
    expect(sendChatAction).toHaveBeenCalledTimes(3);
  });

  it("refcounts concurrent processors on the same chat+thread", async () => {
    const { sendChatAction, deps } = makeDeps();
    const presence = createTelegramPresenceIndicator(deps);
    await presence.onProcessingStart({ chatId: 100, messageId: 1, threadId: 5 });
    await presence.onProcessingStart({ chatId: 100, messageId: 2, threadId: 5 });
    await vi.advanceTimersByTimeAsync(400);
    expect(sendChatAction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PRESENCE_TYPING_INTERVAL_MS);
    expect(sendChatAction).toHaveBeenCalledTimes(2);
    // First processor ends — loop must continue for the second.
    await presence.onProcessingEnd({ chatId: 100, messageId: 1, threadId: 5 });
    await vi.advanceTimersByTimeAsync(PRESENCE_TYPING_INTERVAL_MS);
    expect(sendChatAction).toHaveBeenCalledTimes(3);
    // Second processor ends — loop must stop.
    await presence.onProcessingEnd({ chatId: 100, messageId: 2, threadId: 5 });
    await vi.advanceTimersByTimeAsync(PRESENCE_TYPING_INTERVAL_MS * 2);
    expect(sendChatAction).toHaveBeenCalledTimes(3);
  });
});

describe("createTelegramPresenceIndicator — failure tolerance", () => {
  it("swallows reaction API failures and logs at warn level", async () => {
    const setMessageReaction = vi.fn(async () => {
      throw new Error("403 Forbidden");
    });
    const sendChatAction = vi.fn(async () => undefined);
    const logger = vi.fn();
    const presence = createTelegramPresenceIndicator({
      setMessageReaction,
      sendChatAction,
      logger,
    });
    // Should not throw.
    await presence.onMessageReceived({ chatId: 100, messageId: 7 });
    expect(logger).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("setMessageReaction failed"),
    );
  });

  it("calls onProcessingEnd cleanup even when the prior reaction call failed", async () => {
    const setMessageReaction = vi
      .fn(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new Error("400 Bad Request");
      });
    const sendChatAction = vi.fn(async () => undefined);
    const logger = vi.fn();
    const presence = createTelegramPresenceIndicator({
      setMessageReaction,
      sendChatAction,
      logger,
    });
    await presence.onProcessingStart({ chatId: 100, messageId: 7 });
    await presence.onProcessingEnd({ chatId: 100, messageId: 7 });
    // Should have attempted clear-call.
    expect(setMessageReaction).toHaveBeenLastCalledWith(100, 7, []);
  });
});

describe("createTelegramPresenceIndicator — config", () => {
  it("presence.typing = false skips the typing loop entirely", async () => {
    const { sendChatAction, deps } = makeDeps({ config: { typing: false } });
    const presence = createTelegramPresenceIndicator(deps);
    await presence.onProcessingStart({ chatId: 100, messageId: 7 });
    await vi.advanceTimersByTimeAsync(PRESENCE_TYPING_INTERVAL_MS * 3);
    await presence.onProcessingEnd({ chatId: 100, messageId: 7 });
    expect(sendChatAction).not.toHaveBeenCalled();
  });

  it("presence.reaction = null disables all reaction calls", async () => {
    const { setMessageReaction, deps } = makeDeps({
      config: { reaction: null, workingReaction: null },
    });
    const presence = createTelegramPresenceIndicator(deps);
    await presence.onMessageReceived({ chatId: 100, messageId: 7 });
    await presence.onProcessingStart({ chatId: 100, messageId: 7 });
    await presence.onProcessingEnd({ chatId: 100, messageId: 7 });
    expect(setMessageReaction).not.toHaveBeenCalled();
  });

  it("respects custom reaction emoji overrides", async () => {
    const { setMessageReaction, deps } = makeDeps({
      config: { reaction: "👋", workingReaction: "⚙️" },
    });
    const presence = createTelegramPresenceIndicator(deps);
    await presence.onMessageReceived({ chatId: 100, messageId: 7 });
    expect(setMessageReaction).toHaveBeenLastCalledWith(100, 7, [
      { type: "emoji", emoji: "👋" },
    ]);
    await presence.onProcessingStart({ chatId: 100, messageId: 7 });
    expect(setMessageReaction).toHaveBeenLastCalledWith(100, 7, [
      { type: "emoji", emoji: "⚙️" },
    ]);
  });
});

describe("createTelegramPresenceIndicator — orphan watchdog", () => {
  it("clears a stale reaction after the TTL when onProcessingEnd never fires", async () => {
    const { setMessageReaction, deps } = makeDeps();
    const presence = createTelegramPresenceIndicator(deps);
    await presence.onProcessingStart({ chatId: 100, messageId: 7 });
    setMessageReaction.mockClear();
    // Crash path: end is never invoked. Watchdog must fire after 60s.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(setMessageReaction).toHaveBeenCalledWith(100, 7, []);
  });
});
