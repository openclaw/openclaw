import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramBotOptions } from "./bot.types.js";

const harness = await import("./bot.create-telegram-bot.test-harness.js");
const {
  getLoadConfigMock,
  getLoadSessionStoreMock,
  getOnHandler,
  onSpy,
  replySpy,
  telegramBotDepsForTest,
  telegramBotRuntimeForTest,
} = harness;

const { createTelegramBotCore, setTelegramBotRuntimeForTest } = await import("./bot-core.js");

let createTelegramBot: (opts: TelegramBotOptions) => ReturnType<typeof createTelegramBotCore>;

const loadConfig = getLoadConfigMock();
getLoadSessionStoreMock(); // initializes the shared mock; harness beforeEach keeps it reset

// Debounce short enough to keep tests fast without being so tight that the
// test-framework's own async overhead causes flakiness.
const EDIT_DEBOUNCE_MS = 30;
const TELEGRAM_TEST_TIMINGS = {
  mediaGroupFlushMs: 20,
  textFragmentGapMs: 30,
  editedMessageDebounceMs: EDIT_DEBOUNCE_MS,
} as const;

const ORIGINAL_TZ = process.env.TZ;

describe("edited_message handler", () => {
  beforeAll(async () => {
    process.env.TZ = "UTC";
    setTelegramBotRuntimeForTest(
      telegramBotRuntimeForTest as unknown as Parameters<typeof setTelegramBotRuntimeForTest>[0],
    );
  });

  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  beforeEach(() => {
    onSpy.mockReset();
    replySpy.mockReset();
    replySpy.mockImplementation(async () => undefined);
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    createTelegramBot = (opts) =>
      createTelegramBotCore({ ...opts, telegramDeps: telegramBotDepsForTest });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeEditCtx(params: {
    chatId: number;
    chatType?: string;
    messageId: number;
    fromId: number;
    username?: string;
    text: string;
    updateId: number;
    botId?: number;
  }) {
    return {
      update: { update_id: params.updateId },
      editedMessage: {
        chat: { id: params.chatId, type: params.chatType ?? "private" },
        message_id: params.messageId,
        from: { id: params.fromId, username: params.username ?? "streamer" },
        text: params.text,
        date: 1736380800,
      },
      me: { id: params.botId ?? 99, username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };
  }

  // Wait past the debounce window and allow the full async processing chain to drain.
  const waitForFlush = () => new Promise<void>((r) => setTimeout(r, EDIT_DEBOUNCE_MS * 10));

  it("registers an edited_message handler on the bot", () => {
    createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
    const handler = onSpy.mock.calls.find((c) => c[0] === "edited_message")?.[1];
    expect(handler).toBeDefined();
  });

  it("dispatches to the inbound pipeline after the debounce window", async () => {
    createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
    const handler = getOnHandler("edited_message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler(
      makeEditCtx({ chatId: 7, messageId: 42, fromId: 5, text: "final text", updateId: 200 }),
    );

    // Debounce has not elapsed — pipeline should not have fired yet.
    expect(replySpy).not.toHaveBeenCalled();

    await waitForFlush();

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0] as Record<string, unknown>;
    expect(String(payload.Body)).toContain("final text");
  });

  it("coalesces rapid edits and only dispatches the final version", async () => {
    createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
    const handler = getOnHandler("edited_message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler(
      makeEditCtx({ chatId: 7, messageId: 42, fromId: 5, text: "chunk one", updateId: 301 }),
    );
    await handler(
      makeEditCtx({ chatId: 7, messageId: 42, fromId: 5, text: "chunk one two", updateId: 302 }),
    );
    await handler(
      makeEditCtx({
        chatId: 7,
        messageId: 42,
        fromId: 5,
        text: "chunk one two three",
        updateId: 303,
      }),
    );

    expect(replySpy).not.toHaveBeenCalled();

    await waitForFlush();

    // Only one dispatch — the final version wins.
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0] as Record<string, unknown>;
    expect(String(payload.Body)).toContain("chunk one two three");
  });

  it("treats edits to different message_ids as independent", async () => {
    createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
    const handler = getOnHandler("edited_message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler(
      makeEditCtx({ chatId: 7, messageId: 10, fromId: 5, text: "msg A edit", updateId: 401 }),
    );
    await handler(
      makeEditCtx({ chatId: 7, messageId: 11, fromId: 5, text: "msg B edit", updateId: 402 }),
    );

    await waitForFlush();

    expect(replySpy).toHaveBeenCalledTimes(2);
    const bodies = replySpy.mock.calls.map((c) => String((c[0] as Record<string, unknown>).Body));
    expect(bodies.some((b) => b.includes("msg A edit"))).toBe(true);
    expect(bodies.some((b) => b.includes("msg B edit"))).toBe(true);
  });

  it("skips edits authored by the bot itself", async () => {
    createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
    const handler = getOnHandler("edited_message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    // fromId === botId — our own outgoing message being edited.
    await handler(
      makeEditCtx({
        chatId: 7,
        messageId: 42,
        fromId: 99,
        text: "bot self-edit",
        updateId: 501,
        botId: 99,
      }),
    );

    await waitForFlush();

    expect(replySpy).not.toHaveBeenCalled();
  });
});
