import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { holdTelegramMediaTimeouts } from "./bot-media-timers.test-support.js";
import { telegramBotDepsForTest } from "./bot.media.e2e.test-harness.js";
import { TELEGRAM_TEST_TIMINGS, createBotHandlerWithOptions } from "./bot.media.test-utils.js";

type CreateBuffersSpy = MockInstance<
  typeof import("./bot-handlers.inbound-buffer.js").createTelegramInboundBuffers
>;

async function drainBuffers(createBuffers: CreateBuffersSpy) {
  const buffers = createBuffers.mock.results[0];
  if (buffers?.type !== "return") {
    throw new Error("Expected the bot's inbound buffers");
  }
  await buffers.value.inboundDebouncer.drain();
}

const fragmentMessage = (message_id: number, text: string, date = 1736380800) => ({
  chat: { id: 42, type: "private" as const },
  from: { id: 777, is_bot: false as const, first_name: "Ada" },
  message_id,
  date,
  text,
});
const fragmentContext = (message: object) => ({
  message,
  me: { username: "openclaw_bot" },
  getFile: async () => ({}),
});

// Fragment batches flush on the gap timer or a monotonic deadline anchored at the
// first fragment. Held timers model an in-gap arrival only if that clock is held
// too; otherwise slow admission reschedules the append with an unheld delay.
function holdTelegramFragmentTimers(createBuffers: CreateBuffersSpy) {
  vi.useFakeTimers({ toFake: ["performance"] });
  const setTimeoutSpy = holdTelegramMediaTimeouts(TELEGRAM_TEST_TIMINGS.textFragmentGapMs);
  const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
  const timers = () => {
    const clearedHandles = new Set(clearTimeoutSpy.mock.calls.map(([handle]) => handle));
    return setTimeoutSpy.mock.calls.flatMap(([callback, delay], index) => {
      const handle = setTimeoutSpy.mock.results[index]?.value as ReturnType<typeof setTimeout>;
      return delay === TELEGRAM_TEST_TIMINGS.textFragmentGapMs &&
        !clearedHandles.has(handle) &&
        typeof callback === "function"
        ? [{ callback: callback as () => unknown, handle }]
        : [];
    });
  };
  return {
    timers,
    flush: async () => {
      const timer = timers().at(-1);
      expect(timer?.callback).toBeTypeOf("function");
      if (timer) {
        clearTimeout(timer.handle);
        await timer.callback();
      }
      await drainBuffers(createBuffers);
    },
  };
}

let createBuffers: CreateBuffersSpy;
let originalLoadConfig: typeof telegramBotDepsForTest.getRuntimeConfig;
beforeEach(async () => {
  createBuffers = vi.spyOn(
    await import("./bot-handlers.inbound-buffer.js"),
    "createTelegramInboundBuffers",
  );
  originalLoadConfig = telegramBotDepsForTest.getRuntimeConfig;
});
afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  telegramBotDepsForTest.getRuntimeConfig = originalLoadConfig;
});

const TEXT_FRAGMENT_TEST_TIMEOUT_MS = process.platform === "win32" ? 45_000 : 20_000;
const nearLimitText = (prefix = "", suffix = "") => `${prefix}${"A".repeat(4050)}${suffix}`;

it(
  "buffers slash-prefixed near-limit text with its selected reply quote",
  async () => {
    const { handler, replySpy } = await createBotHandlerWithOptions({});
    const quote = "FRAGMENT_REPLY_QUOTE";
    const part1 = nearLimitText("/not_a_command ", ` ${quote}`);
    const firstMessage = fragmentMessage(10, part1);
    const part2 = "B".repeat(50);
    const { flush } = holdTelegramFragmentTimers(createBuffers);

    await handler(fragmentContext(firstMessage));
    await handler(
      fragmentContext({
        ...fragmentMessage(11, part2, 1736380801),
        reply_to_message: { ...firstMessage, reply_to_message: undefined },
        quote: { text: quote, position: part1.indexOf(quote) },
      }),
    );

    expect(replySpy).not.toHaveBeenCalled();
    await flush();

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls.at(0)?.[0] as { Body?: string; RawBody?: string };
    expect(payload.RawBody).toContain(part1.slice(0, 32));
    expect(payload.RawBody).toContain(part2.slice(0, 32));
    expect(payload.Body).toContain(`[1. Ada id:10]\n"${quote}"`);
  },
  TEXT_FRAGMENT_TEST_TIMEOUT_MS,
);

it(
  "processes leading Telegram bot commands immediately without static registration",
  async () => {
    const { handler, replySpy } = await createBotHandlerWithOptions({});
    const command = "/deploy@openclaw_bot";
    const message = {
      ...fragmentMessage(20, nearLimitText(`${command} `)),
      entities: [{ type: "bot_command", offset: 0, length: command.length }],
    };

    await handler(fragmentContext(message));

    expect(replySpy).toHaveBeenCalledTimes(1);
  },
  TEXT_FRAGMENT_TEST_TIMEOUT_MS,
);

it(
  "keeps per-DM pairing store authorization when flushing text fragments",
  async () => {
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
    vi.spyOn(performance, "now").mockImplementation(() => hostNow() + hostDelayMs);
    const { flush } = holdTelegramFragmentTimers(createBuffers);
    const part1 = "A".repeat(4050);
    const part2 = "B".repeat(50);

    try {
      await handler(fragmentContext(fragmentMessage(30, part1)));

      hostDelayMs = 5 * TELEGRAM_TEST_TIMINGS.textFragmentGapMs;
      await handler(fragmentContext(fragmentMessage(31, part2, 1736380801)));

      await flush();

      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(readAllowFromStore).toHaveBeenCalledWith("telegram", process.env, "default");
      expect(upsertPairingRequest).not.toHaveBeenCalled();
      expect(runtimeError).not.toHaveBeenCalled();
    } finally {
      readAllowFromStore.mockReset();
      readAllowFromStore.mockResolvedValue([]);
    }
  },
  TEXT_FRAGMENT_TEST_TIMEOUT_MS,
);

it(
  "buffers different forum topic fragments independently",
  async () => {
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
    const { timers } = holdTelegramFragmentTimers(createBuffers);

    try {
      const topicMessage = (
        messageId: number,
        text: string,
        threadId: number,
        date = 1736380800,
      ) => ({
        ...fragmentMessage(messageId, text, date),
        chat: { id: -10042, type: "supergroup", is_forum: true },
        message_thread_id: threadId,
        is_topic_message: true,
      });
      await handler(
        fragmentContext(topicMessage(120, `@openclaw_bot topic-one ${"A".repeat(4050)}`, 101)),
      );
      await handler(
        fragmentContext(
          topicMessage(121, `@openclaw_bot topic-two ${"B".repeat(4050)}`, 202, 1736380801),
        ),
      );

      const activeTimers = timers();
      expect(activeTimers).toHaveLength(2);
      for (const timer of activeTimers) {
        clearTimeout(timer.handle);
        await timer.callback();
      }
      await drainBuffers(createBuffers);
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
      for (const timer of timers()) {
        clearTimeout(timer.handle);
      }
    }
  },
  TEXT_FRAGMENT_TEST_TIMEOUT_MS,
);
