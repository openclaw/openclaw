import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { holdTelegramMediaTimeouts } from "./bot-media-timers.test-support.js";
import { telegramBotDepsForTest } from "./bot.media.e2e.test-harness.js";
import { TELEGRAM_TEST_TIMINGS, createBotHandlerWithOptions } from "./bot.media.test-utils.js";

function resolveScheduledTimerForDelay(
  setTimeoutSpy: ReturnType<typeof vi.spyOn>,
  clearTimeoutSpy: ReturnType<typeof vi.spyOn>,
  delayMs: number,
) {
  const clearedHandles = new Set(
    (clearTimeoutSpy.mock.calls as Array<Parameters<typeof clearTimeout>>).map(
      ([handle]) => handle,
    ),
  );
  const timerCalls = setTimeoutSpy.mock.calls as Array<Parameters<typeof setTimeout>>;
  const timerCallIndex = timerCalls.findLastIndex(
    (call, index) =>
      call[1] === delayMs &&
      !clearedHandles.has(
        setTimeoutSpy.mock.results[index]?.value as ReturnType<typeof setTimeout>,
      ),
  );
  const flushTimer =
    timerCallIndex >= 0
      ? (timerCalls[timerCallIndex]?.[0] as (() => unknown) | undefined)
      : undefined;
  if (timerCallIndex >= 0) {
    clearTimeout(
      setTimeoutSpy.mock.results[timerCallIndex]?.value as ReturnType<typeof setTimeout>,
    );
  }
  return flushTimer;
}

type CreateBuffersSpy = MockInstance<
  typeof import("./bot-handlers.inbound-buffer.js").createTelegramInboundBuffers
>;

async function flushScheduledTimerForDelay(
  setTimeoutSpy: ReturnType<typeof vi.spyOn>,
  clearTimeoutSpy: ReturnType<typeof vi.spyOn>,
  delayMs: number,
  createBuffers: CreateBuffersSpy,
) {
  const flushTimer = resolveScheduledTimerForDelay(setTimeoutSpy, clearTimeoutSpy, delayMs);
  expect(flushTimer).toBeTypeOf("function");
  await flushTimer?.();
  const buffers = createBuffers.mock.results[0];
  if (buffers?.type !== "return") {
    throw new Error("Expected the bot's inbound buffers");
  }
  await buffers.value.inboundDebouncer.drain();
}

type ScheduledTimer = {
  callback: () => unknown;
  handle: ReturnType<typeof setTimeout>;
};

function resolveActiveScheduledTimersForDelay(
  setTimeoutSpy: ReturnType<typeof vi.spyOn>,
  clearTimeoutSpy: ReturnType<typeof vi.spyOn>,
  delayMs: number,
): ScheduledTimer[] {
  const clearedHandles = new Set(
    (clearTimeoutSpy.mock.calls as Array<Parameters<typeof clearTimeout>>).map(
      ([handle]) => handle,
    ),
  );
  return (setTimeoutSpy.mock.calls as Array<Parameters<typeof setTimeout>>).flatMap(
    (call, index) => {
      if (call[1] !== delayMs) {
        return [];
      }
      const handle = setTimeoutSpy.mock.results[index]?.value as ReturnType<typeof setTimeout>;
      if (clearedHandles.has(handle) || typeof call[0] !== "function") {
        return [];
      }
      return [{ callback: call[0] as () => unknown, handle }];
    },
  );
}

// Fragment batches flush on the gap timer or a monotonic deadline anchored at the
// first fragment. Held timers model an in-gap arrival only if that clock is held
// too; otherwise slow admission reschedules the append with an unheld delay.
function holdTelegramFragmentTimers() {
  vi.useFakeTimers({ toFake: ["performance"] });
  const setTimeoutSpy = holdTelegramMediaTimeouts(TELEGRAM_TEST_TIMINGS.textFragmentGapMs);
  const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
  return {
    setTimeoutSpy,
    clearTimeoutSpy,
    restore: () => {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    },
  };
}

describe("telegram text fragments", () => {
  afterEach(() => {
    vi.clearAllTimers();
  });

  const TEXT_FRAGMENT_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;
  const buildNearLimitMessage = (params: {
    messageId: number;
    prefix?: string;
    suffix?: string;
    entities?: Array<{ type: "bot_command"; offset: number; length: number }>;
  }) => {
    const text = `${params.prefix ?? ""}${"A".repeat(4050)}${params.suffix ?? ""}`;
    return {
      text,
      message: {
        chat: { id: 42, type: "private" as const },
        from: { id: 777, is_bot: false as const, first_name: "Ada" },
        message_id: params.messageId,
        date: 1736380800,
        text,
        ...(params.entities ? { entities: params.entities } : {}),
      },
    };
  };

  it(
    "buffers slash-prefixed near-limit text with its selected reply quote",
    async () => {
      const bufferRuntime = await import("./bot-handlers.inbound-buffer.js");
      const createBuffers = vi.spyOn(bufferRuntime, "createTelegramInboundBuffers");
      const prefix = "/not_a_command ";
      const { handler, replySpy } = await createBotHandlerWithOptions({});
      const quote = "FRAGMENT_REPLY_QUOTE";
      const { text: part1, message: firstMessage } = buildNearLimitMessage({
        messageId: 10,
        prefix,
        suffix: ` ${quote}`,
      });
      const part2 = "B".repeat(50);
      const { setTimeoutSpy, clearTimeoutSpy, restore } = holdTelegramFragmentTimers();

      try {
        await handler({
          message: firstMessage,
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        });

        await handler({
          message: {
            chat: { id: 42, type: "private" },
            from: { id: 777, is_bot: false, first_name: "Ada" },
            message_id: 11,
            date: 1736380801,
            text: part2,
            reply_to_message: { ...firstMessage, reply_to_message: undefined },
            quote: { text: quote, position: part1.indexOf(quote) },
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        });

        expect(replySpy).not.toHaveBeenCalled();
        await flushScheduledTimerForDelay(
          setTimeoutSpy,
          clearTimeoutSpy,
          TELEGRAM_TEST_TIMINGS.textFragmentGapMs,
          createBuffers,
        );

        expect(replySpy).toHaveBeenCalledTimes(1);
        const payload = replySpy.mock.calls.at(0)?.[0] as { Body?: string; RawBody?: string };
        expect(payload.RawBody).toContain(part1.slice(0, 32));
        expect(payload.RawBody).toContain(part2.slice(0, 32));
        expect(payload.Body).toContain(`[1. Ada id:10]\n"${quote}"`);
      } finally {
        restore();
        createBuffers.mockRestore();
      }
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );

  it(
    "processes leading Telegram bot commands immediately without static registration",
    async () => {
      const { handler, replySpy } = await createBotHandlerWithOptions({});
      const command = "/deploy@openclaw_bot";
      const { message } = buildNearLimitMessage({
        messageId: 20,
        prefix: `${command} `,
        entities: [{ type: "bot_command", offset: 0, length: command.length }],
      });

      await handler({
        message,
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );

  it(
    "keeps per-DM pairing store authorization when flushing text fragments",
    async () => {
      const bufferRuntime = await import("./bot-handlers.inbound-buffer.js");
      const createBuffers = vi.spyOn(bufferRuntime, "createTelegramInboundBuffers");
      const originalLoadConfig = telegramBotDepsForTest.getRuntimeConfig;
      telegramBotDepsForTest.getRuntimeConfig = (() => ({
        messages: { inbound: { debounceMs: 0 } },
        channels: {
          telegram: {
            dmPolicy: "open",
            direct: {
              "42": { dmPolicy: "pairing" },
            },
          },
        },
      })) as typeof telegramBotDepsForTest.getRuntimeConfig;

      const readAllowFromStore = vi.mocked(telegramBotDepsForTest.readChannelAllowFromStore);
      const upsertPairingRequest = vi.mocked(telegramBotDepsForTest.upsertChannelPairingRequest);
      readAllowFromStore.mockReset();
      readAllowFromStore.mockResolvedValue(["777"]);
      upsertPairingRequest.mockClear();

      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      // A loaded runner can spend the whole 5x-gap batch window admitting the
      // second fragment; held flushes must not depend on host monotonic time.
      const hostNow = performance.now.bind(performance);
      let hostDelayMs = 0;
      const hostClock = vi
        .spyOn(performance, "now")
        .mockImplementation(() => hostNow() + hostDelayMs);
      const { setTimeoutSpy, clearTimeoutSpy, restore } = holdTelegramFragmentTimers();
      const part1 = "A".repeat(4050);
      const part2 = "B".repeat(50);

      try {
        await handler({
          message: {
            chat: { id: 42, type: "private" },
            from: { id: 777, is_bot: false, first_name: "Ada" },
            message_id: 30,
            date: 1736380800,
            text: part1,
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        });

        hostDelayMs = 5 * TELEGRAM_TEST_TIMINGS.textFragmentGapMs;
        await handler({
          message: {
            chat: { id: 42, type: "private" },
            from: { id: 777, is_bot: false, first_name: "Ada" },
            message_id: 31,
            date: 1736380801,
            text: part2,
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        });

        await flushScheduledTimerForDelay(
          setTimeoutSpy,
          clearTimeoutSpy,
          TELEGRAM_TEST_TIMINGS.textFragmentGapMs,
          createBuffers,
        );

        expect(replySpy).toHaveBeenCalledTimes(1);
        expect(readAllowFromStore).toHaveBeenCalledWith("telegram", process.env, "default");
        expect(upsertPairingRequest).not.toHaveBeenCalled();
        expect(runtimeError).not.toHaveBeenCalled();
      } finally {
        restore();
        hostClock.mockRestore();
        createBuffers.mockRestore();
        telegramBotDepsForTest.getRuntimeConfig = originalLoadConfig;
        readAllowFromStore.mockReset();
        readAllowFromStore.mockResolvedValue([]);
      }
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );

  it(
    "buffers different forum topic fragments independently",
    async () => {
      const bufferRuntime = await import("./bot-handlers.inbound-buffer.js");
      const createBuffers = vi.spyOn(bufferRuntime, "createTelegramInboundBuffers");
      const originalLoadConfig = telegramBotDepsForTest.getRuntimeConfig;
      telegramBotDepsForTest.getRuntimeConfig = (() => ({
        messages: { inbound: { debounceMs: 0 } },
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            groupAllowFrom: ["777"],
            groupPolicy: "open",
            groups: {
              "-10042": { allowFrom: ["777"], groupPolicy: "open", requireMention: false },
            },
          },
        },
      })) as typeof telegramBotDepsForTest.getRuntimeConfig;

      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const { setTimeoutSpy, clearTimeoutSpy, restore } = holdTelegramFragmentTimers();

      try {
        await handler({
          message: {
            chat: { id: -10042, type: "supergroup", is_forum: true },
            from: { id: 777, is_bot: false, first_name: "Ada" },
            message_id: 120,
            message_thread_id: 101,
            is_topic_message: true,
            date: 1736380800,
            text: `@openclaw_bot topic-one ${"A".repeat(4050)}`,
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        });

        await handler({
          message: {
            chat: { id: -10042, type: "supergroup", is_forum: true },
            from: { id: 777, is_bot: false, first_name: "Ada" },
            message_id: 121,
            message_thread_id: 202,
            is_topic_message: true,
            date: 1736380801,
            text: `@openclaw_bot topic-two ${"B".repeat(4050)}`,
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        });

        const timers = resolveActiveScheduledTimersForDelay(
          setTimeoutSpy,
          clearTimeoutSpy,
          TELEGRAM_TEST_TIMINGS.textFragmentGapMs,
        );
        expect(timers).toHaveLength(2);
        for (const timer of timers) {
          clearTimeout(timer.handle);
          await timer.callback();
        }
        const buffers = createBuffers.mock.results[0];
        if (buffers?.type !== "return") {
          throw new Error("Expected the bot's inbound buffers");
        }
        await buffers.value.inboundDebouncer.drain();
        expect(replySpy).toHaveBeenCalledTimes(2);
        const rawBodies = replySpy.mock.calls.map(
          (call) => (call[0] as { RawBody?: string }).RawBody,
        );
        expect(rawBodies).toEqual(
          expect.arrayContaining([
            expect.stringContaining("topic-one"),
            expect.stringContaining("topic-two"),
          ]),
        );
        expect(runtimeError).not.toHaveBeenCalled();
      } finally {
        for (const timer of resolveActiveScheduledTimersForDelay(
          setTimeoutSpy,
          clearTimeoutSpy,
          TELEGRAM_TEST_TIMINGS.textFragmentGapMs,
        )) {
          clearTimeout(timer.handle);
        }
        restore();
        createBuffers.mockRestore();
        telegramBotDepsForTest.getRuntimeConfig = originalLoadConfig;
      }
    },
    TEXT_FRAGMENT_TEST_TIMEOUT_MS,
  );
});
