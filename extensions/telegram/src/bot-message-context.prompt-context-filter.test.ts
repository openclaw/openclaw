import { describe, expect, it } from "vitest";
import {
  filterTelegramPromptContextForPersistentDm,
  shouldSuppressTelegramChatWindowPromptContext,
} from "./bot-message-context.prompt-context-filter.js";
import type { TelegramPromptContextEntry } from "./bot-message-context.types.js";

const baseChatWindow: TelegramPromptContextEntry = {
  label: "Conversation context",
  source: "telegram",
  type: "chat_window",
  payload: {
    order: "chronological",
    relation: "selected_for_current_message",
    messages: [
      {
        message_id: "1",
        sender: "Alice",
        timestamp_ms: 1700000000000,
        body: "hi",
      },
    ],
  },
} as unknown as TelegramPromptContextEntry;

describe("shouldSuppressTelegramChatWindowPromptContext", () => {
  it("suppresses chat_window for a persistent private DM (issue #87566 happy path)", () => {
    expect(
      shouldSuppressTelegramChatWindowPromptContext({
        isGroup: false,
        threadId: null,
        previousTimestampMs: 1700000000000,
      }),
    ).toBe(true);
  });

  it("keeps chat_window for a fresh private DM session (no prior session activity)", () => {
    expect(
      shouldSuppressTelegramChatWindowPromptContext({
        isGroup: false,
        threadId: null,
        previousTimestampMs: undefined,
      }),
    ).toBe(false);
  });

  it("keeps chat_window for group/supergroup chats even when session has prior activity", () => {
    expect(
      shouldSuppressTelegramChatWindowPromptContext({
        isGroup: true,
        threadId: null,
        previousTimestampMs: 1700000000000,
      }),
    ).toBe(false);
  });

  it("keeps chat_window when the chat is a forum/topic thread", () => {
    expect(
      shouldSuppressTelegramChatWindowPromptContext({
        isGroup: true,
        threadId: 42,
        previousTimestampMs: 1700000000000,
      }),
    ).toBe(false);
  });

  it("keeps chat_window for a private DM that has a topic/thread id (DM topic)", () => {
    expect(
      shouldSuppressTelegramChatWindowPromptContext({
        isGroup: false,
        threadId: 99,
        previousTimestampMs: 1700000000000,
      }),
    ).toBe(false);
  });

  it("treats previousTimestampMs <= 0 as fresh", () => {
    expect(
      shouldSuppressTelegramChatWindowPromptContext({
        isGroup: false,
        threadId: null,
        previousTimestampMs: 0,
      }),
    ).toBe(false);
  });
});

describe("filterTelegramPromptContextForPersistentDm", () => {
  it("drops chat_window entries for persistent DMs", () => {
    const filtered = filterTelegramPromptContextForPersistentDm([baseChatWindow], {
      isGroup: false,
      threadId: null,
      previousTimestampMs: 1700000000000,
    });
    expect(filtered).toEqual([]);
  });

  it("keeps chat_window entries when suppression does not apply", () => {
    const filtered = filterTelegramPromptContextForPersistentDm([baseChatWindow], {
      isGroup: false,
      threadId: null,
      previousTimestampMs: undefined,
    });
    expect(filtered).toEqual([baseChatWindow]);
  });

  it("returns the exact same array reference when suppression does not apply (zero-cost no-op)", () => {
    const input = [baseChatWindow];
    const out = filterTelegramPromptContextForPersistentDm(input, {
      isGroup: true,
      threadId: null,
      previousTimestampMs: 1700000000000,
    });
    expect(out).toBe(input);
  });

  it("only drops chat_window entries and leaves other prompt-context types intact", () => {
    const otherEntry = {
      label: "Other",
      source: "telegram",
      type: "future_type_kept_for_forward_compat",
      payload: {},
    } as unknown as TelegramPromptContextEntry;
    const filtered = filterTelegramPromptContextForPersistentDm([baseChatWindow, otherEntry], {
      isGroup: false,
      threadId: null,
      previousTimestampMs: 1700000000000,
    });
    expect(filtered).toEqual([otherEntry]);
  });

  it("handles empty input gracefully", () => {
    expect(
      filterTelegramPromptContextForPersistentDm([], {
        isGroup: false,
        threadId: null,
        previousTimestampMs: 1700000000000,
      }),
    ).toEqual([]);
  });
});
