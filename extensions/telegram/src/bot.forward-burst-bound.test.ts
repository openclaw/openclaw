import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { makeTelegramConfig } from "./bot.config.test-support.js";
import { telegramBotDepsForTest } from "./bot.media.e2e.test-harness.js";
import { createBotHandlerWithOptions } from "./bot.media.test-utils.js";

type CreateBuffersSpy = MockInstance<
  typeof import("./bot-handlers.inbound-buffer.js").createTelegramInboundBuffers
>;

const FORWARD_BURST_QUIET_MS = 1_000;

const forwardMessage = (messageId: number, text: string) => ({
  chat: { id: 42, type: "private" as const },
  from: { id: 777, is_bot: false as const, first_name: "Ada" },
  message_id: messageId,
  date: 1736380800,
  text,
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

function flushMarkers(replySpy: ReturnType<typeof vi.fn>, pattern: RegExp) {
  const perFlush: string[][] = [];
  for (let call = 0; call < replySpy.mock.calls.length; call += 1) {
    const payload = replySpy.mock.calls.at(call)?.[0] as { Body?: string; RawBody?: string };
    const body = payload?.RawBody || payload?.Body || "";
    perFlush.push(body.match(pattern) ?? []);
  }
  return perFlush;
}

let createBuffers: CreateBuffersSpy;
let originalLoadConfig: typeof telegramBotDepsForTest.getRuntimeConfig;
beforeEach(async () => {
  createBuffers = vi.spyOn(
    await import("./bot-handlers.inbound-buffer.js"),
    "createTelegramInboundBuffers",
  );
  originalLoadConfig = telegramBotDepsForTest.getRuntimeConfig;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  telegramBotDepsForTest.getRuntimeConfig = originalLoadConfig;
});

it("bounds one sender's forwarded burst instead of collecting it without a limit", async () => {
  const runtimeError = vi.fn();
  const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
  const markers = Array.from(
    { length: 30 },
    (unused, index) => `fwd-${String(index).padStart(3, "0")}`,
  );

  for (const [index, marker] of markers.entries()) {
    await handler(messageContext(forwardMessage(100 + index, marker)));
  }

  // Arrivals land inside one forward quiet window; only the batch boundary
  // can split them, so the size assertion fails when the lane is unbounded.
  await vi.advanceTimersByTimeAsync(FORWARD_BURST_QUIET_MS * 6);
  const buffers = createBuffers.mock.results[0];
  if (buffers?.type !== "return") {
    throw new Error("Expected the bot's inbound buffers");
  }
  await buffers.value.inboundDebouncer.drain();

  const perFlush = flushMarkers(replySpy, /fwd-\d{3}/g);
  expect(perFlush.flat()).toEqual(markers);
  expect(perFlush.map((flush) => flush.length)).toEqual([12, 12, 6]);
  // Store-degraded lanes report plugin-state warnings on this host; only
  // handler-level failures mean the forwarded burst was not delivered.
  const handlerFailures = runtimeError.mock.calls
    .map((call) => String(call[0] ?? ""))
    .filter((message) => message.includes("handler failed"));
  expect(handlerFailures).toEqual([]);
}, 90_000);

it("keeps the ordinary-text batch cap unchanged", async () => {
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
  await vi.advanceTimersByTimeAsync(1_000);

  const buffers = createBuffers.mock.results[0];
  if (buffers?.type !== "return") {
    throw new Error("Expected the bot's inbound buffers");
  }
  await buffers.value.inboundDebouncer.drain();

  const perFlush = flushMarkers(replySpy, /txt-\d{2}/g);
  expect(perFlush.flat()).toEqual(markers);
  expect(perFlush.map((flush) => flush.length)).toEqual([12, 2]);
}, 90_000);
