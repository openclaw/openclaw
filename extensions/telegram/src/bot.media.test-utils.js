import { afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import * as ssrf from "../../../src/infra/net/ssrf.js";
import { onSpy, sendChatActionSpy } from "./bot.media.e2e-harness.js";
const cacheStickerSpy = vi.fn();
const getCachedStickerSpy = vi.fn();
const describeStickerImageSpy = vi.fn();
const resolvePinnedHostname = ssrf.resolvePinnedHostname;
const lookupMock = vi.fn();
let resolvePinnedHostnameSpy = null;
const TELEGRAM_TEST_TIMINGS = {
  mediaGroupFlushMs: 20,
  textFragmentGapMs: 30
};
const TELEGRAM_BOT_IMPORT_TIMEOUT_MS = process.platform === "win32" ? 18e4 : 15e4;
let createTelegramBotRef;
let replySpyRef;
async function createBotHandler() {
  return createBotHandlerWithOptions({});
}
async function createBotHandlerWithOptions(options) {
  onSpy.mockClear();
  replySpyRef.mockClear();
  sendChatActionSpy.mockClear();
  const runtimeError = options.runtimeError ?? vi.fn();
  const runtimeLog = options.runtimeLog ?? vi.fn();
  createTelegramBotRef({
    token: "tok",
    testTimings: TELEGRAM_TEST_TIMINGS,
    ...options.proxyFetch ? { proxyFetch: options.proxyFetch } : {},
    runtime: {
      log: runtimeLog,
      error: runtimeError,
      exit: () => {
        throw new Error("exit");
      }
    }
  });
  const handler = onSpy.mock.calls.find((call) => call[0] === "message")?.[1];
  expect(handler).toBeDefined();
  return { handler, replySpy: replySpyRef, runtimeError };
}
function mockTelegramFileDownload(params) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => params.contentType },
    arrayBuffer: async () => params.bytes.buffer
  });
}
function mockTelegramPngDownload() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => "image/png" },
    arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer
  });
}
beforeEach(() => {
  vi.useRealTimers();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  resolvePinnedHostnameSpy = vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation((hostname) => resolvePinnedHostname(hostname, lookupMock));
});
afterEach(() => {
  lookupMock.mockClear();
  resolvePinnedHostnameSpy?.mockRestore();
  resolvePinnedHostnameSpy = null;
});
beforeAll(async () => {
  ({ createTelegramBot: createTelegramBotRef } = await import("./bot.js"));
  const replyModule = await import("../../../src/auto-reply/reply.js");
  replySpyRef = replyModule.__replySpy;
}, TELEGRAM_BOT_IMPORT_TIMEOUT_MS);
vi.mock("./sticker-cache.js", () => ({
  cacheSticker: (...args) => cacheStickerSpy(...args),
  getCachedSticker: (...args) => getCachedStickerSpy(...args),
  describeStickerImage: (...args) => describeStickerImageSpy(...args)
}));
export {
  TELEGRAM_TEST_TIMINGS,
  cacheStickerSpy,
  createBotHandler,
  createBotHandlerWithOptions,
  describeStickerImageSpy,
  getCachedStickerSpy,
  mockTelegramFileDownload,
  mockTelegramPngDownload
};
