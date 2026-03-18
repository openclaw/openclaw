import * as ssrf from "openclaw/plugin-sdk/infra-runtime";
import { afterEach, beforeAll, beforeEach, expect, vi, type Mock } from "vitest";

type StickerSpy = Mock<(...args: unknown[]) => unknown>;

export const cacheStickerSpy: StickerSpy = vi.fn();
export const getCachedStickerSpy: StickerSpy = vi.fn();
export const describeStickerImageSpy: StickerSpy = vi.fn();

const resolvePinnedHostname = ssrf.resolvePinnedHostname;
const lookupMock = vi.fn();
let resolvePinnedHostnameSpy: ReturnType<typeof vi.spyOn> = null;

export const TELEGRAM_TEST_TIMINGS = {
  mediaGroupFlushMs: 20,
  textFragmentGapMs: 30,
} as const;

const TELEGRAM_BOT_IMPORT_TIMEOUT_MS = process.platform === "win32" ? 180_000 : 150_000;

let createTelegramBotRef: typeof import("./bot.js").createTelegramBot;
let replySpyRef: ReturnType<typeof vi.fn>;
let onSpyRef: Mock;
let sendChatActionSpyRef: Mock;
let fetchRemoteMediaSpyRef: Mock;
let resetFetchRemoteMediaMockRef: () => void;

type FetchMockHandle = Mock & { mockRestore: () => void };

function createFetchMockHandle(): FetchMockHandle {
  return Object.assign(fetchRemoteMediaSpyRef, {
    mockRestore: () => {
      resetFetchRemoteMediaMockRef();
    },
  }) as FetchMockHandle;
}

export async function createBotHandler(): Promise<{
  handler: (ctx: Record<string, unknown>) => Promise<void>;
  replySpy: ReturnType<typeof vi.fn>;
  runtimeError: ReturnType<typeof vi.fn>;
}> {
  return createBotHandlerWithOptions({});
}

export async function createBotHandlerWithOptions(options: {
  proxyFetch?: typeof fetch;
  runtimeLog?: ReturnType<typeof vi.fn>;
  runtimeError?: ReturnType<typeof vi.fn>;
}): Promise<{
  handler: (ctx: Record<string, unknown>) => Promise<void>;
  replySpy: ReturnType<typeof vi.fn>;
  runtimeError: ReturnType<typeof vi.fn>;
}> {
  onSpyRef.mockClear();
  replySpyRef.mockClear();
  sendChatActionSpyRef.mockClear();

  const runtimeError = options.runtimeError ?? vi.fn();
  const runtimeLog = options.runtimeLog ?? vi.fn();
  createTelegramBotRef({
    token: "tok",
    testTimings: TELEGRAM_TEST_TIMINGS,
    ...(options.proxyFetch ? { proxyFetch: options.proxyFetch } : {}),
    runtime: {
      log: runtimeLog as (...data: unknown[]) => void,
      error: runtimeError as (...data: unknown[]) => void,
      exit: () => {
        throw new Error("exit");
      },
    },
  });
  const handler = onSpyRef.mock.calls.find((call) => call[0] === "message")?.[1] as (
    ctx: Record<string, unknown>,
  ) => Promise<void>;
  expect(handler).toBeDefined();
  return { handler, replySpy: replySpyRef, runtimeError };
}

export function mockTelegramFileDownload(params: {
  contentType: string;
  bytes: Uint8Array;
}): FetchMockHandle {
  fetchRemoteMediaSpyRef.mockResolvedValueOnce({
    buffer: Buffer.from(params.bytes),
    contentType: params.contentType,
    fileName: "mock-file",
  });
  return createFetchMockHandle();
}

export function mockTelegramPngDownload(): FetchMockHandle {
  fetchRemoteMediaSpyRef.mockResolvedValue({
    buffer: Buffer.from(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    contentType: "image/png",
    fileName: "mock-file.png",
  });
  return createFetchMockHandle();
}

export function watchTelegramFetch(): FetchMockHandle {
  return createFetchMockHandle();
}

beforeEach(() => {
  vi.useRealTimers();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  resolvePinnedHostnameSpy = vi
    .spyOn(ssrf, "resolvePinnedHostname")
    .mockImplementation((hostname) => resolvePinnedHostname(hostname, lookupMock));
});

afterEach(() => {
  lookupMock.mockClear();
  resolvePinnedHostnameSpy?.mockRestore();
  resolvePinnedHostnameSpy = null;
});

beforeAll(async () => {
  const harness = await import("./bot.media.e2e-harness.js");
  onSpyRef = harness.onSpy;
  sendChatActionSpyRef = harness.sendChatActionSpy;
  fetchRemoteMediaSpyRef = harness.fetchRemoteMediaSpy;
  resetFetchRemoteMediaMockRef = harness.resetFetchRemoteMediaMock;
  const botModule = await import("./bot.js");
  botModule.setTelegramBotRuntimeForTest(
    harness.telegramBotRuntimeForTest as unknown as Parameters<
      typeof botModule.setTelegramBotRuntimeForTest
    >[0],
  );
  createTelegramBotRef = (opts) =>
    botModule.createTelegramBot({
      ...opts,
      telegramDeps: harness.telegramBotDepsForTest,
    });
  const replyModule = await import("openclaw/plugin-sdk/reply-runtime");
  replySpyRef = (replyModule as unknown as { __replySpy: ReturnType<typeof vi.fn> }).__replySpy;
}, TELEGRAM_BOT_IMPORT_TIMEOUT_MS);

vi.mock("./sticker-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sticker-cache.js")>();
  return {
    ...actual,
    cacheSticker: (...args: unknown[]) => cacheStickerSpy(...args),
    getCachedSticker: (...args: unknown[]) => getCachedStickerSpy(...args),
    describeStickerImage: (...args: unknown[]) => describeStickerImageSpy(...args),
  };
});
