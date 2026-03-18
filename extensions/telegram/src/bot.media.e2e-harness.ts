import { resetInboundDedupe } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, vi, type Mock } from "vitest";

export const useSpy: Mock = vi.fn();
export const middlewareUseSpy: Mock = vi.fn();
export const onSpy: Mock = vi.fn();
export const stopSpy: Mock = vi.fn();
export const sendChatActionSpy: Mock = vi.fn();
export const undiciFetchSpy: Mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
  globalThis.fetch(input, init),
);

async function defaultSaveMediaBuffer(buffer: Buffer, contentType?: string) {
  return {
    id: "media",
    path: "/tmp/telegram-media",
    size: buffer.byteLength,
    contentType: contentType ?? "application/octet-stream",
  };
}

const saveMediaBufferSpy: Mock = vi.fn(defaultSaveMediaBuffer);

export function setNextSavedMediaPath(params: {
  path: string;
  id?: string;
  contentType?: string;
  size?: number;
}) {
  saveMediaBufferSpy.mockImplementationOnce(
    async (buffer: Buffer, detectedContentType?: string) => ({
      id: params.id ?? "media",
      path: params.path,
      size: params.size ?? buffer.byteLength,
      contentType: params.contentType ?? detectedContentType ?? "application/octet-stream",
    }),
  );
}

export function resetSaveMediaBufferMock() {
  saveMediaBufferSpy.mockReset();
  saveMediaBufferSpy.mockImplementation(defaultSaveMediaBuffer);
}

type ApiStub = {
  config: { use: (arg: unknown) => void };
  sendChatAction: Mock;
  sendMessage: Mock;
  setMyCommands: (commands: Array<{ command: string; description: string }>) => Promise<void>;
};

const apiStub: ApiStub = {
  config: { use: useSpy },
  sendChatAction: sendChatActionSpy,
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  setMyCommands: vi.fn(async () => undefined),
};

export const telegramBotRuntimeForTest = {
  Bot: class {
    api = apiStub;
    use = middlewareUseSpy;
    on = onSpy;
    command = vi.fn();
    stop = stopSpy;
    catch = vi.fn();
    constructor(public token: string) {}
  },
  sequentialize: () => vi.fn(),
  apiThrottler: () => throttlerSpy(),
  loadConfig: () => ({
    channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
  }),
};

beforeEach(() => {
  resetInboundDedupe();
  resetSaveMediaBufferMock();
});

const throttlerSpy = vi.fn(() => "throttler");

vi.doMock("./bot.runtime.js", () => ({
  ...telegramBotRuntimeForTest,
}));

vi.doMock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: (...args: Parameters<typeof undiciFetchSpy>) => undiciFetchSpy(...args),
  };
});

vi.doMock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  const mockModule = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(mockModule, Object.getOwnPropertyDescriptors(actual));
  Object.defineProperty(mockModule, "saveMediaBuffer", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: (...args: Parameters<typeof saveMediaBufferSpy>) => saveMediaBufferSpy(...args),
  });
  return mockModule;
});

vi.doMock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    loadConfig: () => ({
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    }),
  };
});

vi.doMock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    updateLastRoute: vi.fn(async () => undefined),
  };
});

vi.doMock("openclaw/plugin-sdk/conversation-runtime", () => ({
  readChannelAllowFromStore: vi.fn(async () => [] as string[]),
  upsertChannelPairingRequest: vi.fn(async () => ({
    code: "PAIRCODE",
    created: true,
  })),
}));

vi.doMock("openclaw/plugin-sdk/reply-runtime", () => {
  const replySpy = vi.fn(async (_ctx, opts) => {
    await opts?.onReplyStart?.();
    return undefined;
  });
  return { getReplyFromConfig: replySpy, __replySpy: replySpy };
});
