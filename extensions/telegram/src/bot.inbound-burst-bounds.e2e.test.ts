import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { makeTelegramConfig } from "./bot.config.test-support.js";
import { telegramBotDepsForTest } from "./bot.media.e2e.test-harness.js";
import { createBotHandlerWithOptions } from "./bot.media.test-utils.js";

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

function deliveredMarkers(replySpy: ReturnType<typeof vi.fn>, markers: readonly string[]) {
  const perFlush: string[][] = [];
  for (let call = 0; call < replySpy.mock.calls.length; call += 1) {
    const payload = replySpy.mock.calls.at(call)?.[0] as { Body?: string; RawBody?: string };
    const body = `${payload?.RawBody ?? ""}\n${payload?.Body ?? ""}`;
    perFlush.push(markers.filter((marker) => body.includes(marker)));
  }
  return perFlush;
}

const forwardMessage = (messageId: number, text: string) => ({
  chat: { id: 42, type: "private" as const },
  from: { id: 777, is_bot: false as const, first_name: "Ada" },
  message_id: messageId,
  date: 1736380800,
  text,
  // Forward-lane classification only checks presence; production forwards reach
  // the debouncer's channel-unbounded lane, which the shared cap must bound.
  forward_origin: { date: 1736380700, from_user: { id: 777, is_bot: false, first_name: "Ada" } },
});

const plainMessage = (messageId: number, text: string) => ({
  chat: { id: 42, type: "private" as const },
  from: { id: 777, is_bot: false as const, first_name: "Ada" },
  message_id: messageId,
  date: 1736380800,
  text,
});

const messageContext = (message: object) => ({
  message,
  me: { username: "openclaw_bot" },
  getFile: async () => ({}),
});

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

const BURST_TEST_TIMEOUT_MS = process.platform === "win32" ? 180_000 : 90_000;

it(
  "bounds one sender's forward burst through the real bot handler without loss",
  async () => {
    const runtimeError = vi.fn();
    const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
    const markers = Array.from(
      { length: 150 },
      (unused, index) => `fwd-${String(index).padStart(3, "0")}`,
    );

    for (const [index, marker] of markers.entries()) {
      await handler(messageContext(forwardMessage(100 + index, marker)));
    }
    await drainBuffers(createBuffers);

    // Real handler I/O paces arrivals, so batches split by the anchored deadline
    // rather than only by the 100-item seal; the invariant under proof is that
    // the channel-unbounded forward lane stays bounded per flush and delivers
    // every marker exactly once, in arrival order.
    const perFlush = deliveredMarkers(replySpy, markers);
    expect(perFlush.flat()).toEqual(markers);
    expect(Math.max(...perFlush.map((flush) => flush.length))).toBeLessThanOrEqual(100);
    expect(runtimeError).not.toHaveBeenCalled();
  },
  BURST_TEST_TIMEOUT_MS,
);

it(
  "keeps the channel-owned ordinary-text cap ahead of the shared item cap",
  async () => {
    telegramBotDepsForTest.getRuntimeConfig = (() =>
      makeTelegramConfig(
        { dmPolicy: "open", allowFrom: ["*"] },
        { messages: { inbound: { debounceMs: 300 } } },
      )) as typeof telegramBotDepsForTest.getRuntimeConfig;
    const runtimeError = vi.fn();
    const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
    const markers = Array.from(
      { length: 14 },
      (unused, index) => `txt-${String(index).padStart(2, "0")}`,
    );

    for (const [index, marker] of markers.entries()) {
      await handler(messageContext(plainMessage(200 + index, marker)));
    }
    await drainBuffers(createBuffers);

    // Telegram's own canAppend bound (12 items) stays the binding limit even
    // though the shared default (100) is looser; every marker arrives in order.
    const perFlush = deliveredMarkers(replySpy, markers);
    expect(perFlush.flat()).toEqual(markers);
    expect(Math.max(...perFlush.map((flush) => flush.length))).toBeLessThanOrEqual(12);
    expect(perFlush.length).toBeGreaterThan(1);
    expect(runtimeError).not.toHaveBeenCalled();
  },
  BURST_TEST_TIMEOUT_MS,
);
