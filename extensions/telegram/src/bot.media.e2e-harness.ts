import { beforeEach, vi, type Mock } from "vitest";
import { resetInboundDedupe } from "../../../src/auto-reply/reply/inbound-dedupe.js";

export const useSpy: Mock = vi.fn();
export const middlewareUseSpy: Mock = vi.fn();
export const onSpy: Mock = vi.fn();
export const stopSpy: Mock = vi.fn();
export const sendChatActionSpy: Mock = vi.fn();
export const sendMessageSpy: Mock = vi.fn(async () => ({ message_id: 1 }));
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
  sendMessage: sendMessageSpy,
  setMyCommands: vi.fn(async () => undefined),
};

beforeEach(() => {
  resetInboundDedupe();
  resetSaveMediaBufferMock();
});

vi.mock("grammy", () => ({
  Bot: class {
    api = apiStub;
    use = middlewareUseSpy;
    on = onSpy;
    command = vi.fn();
    stop = stopSpy;
    catch = vi.fn();
    constructor(public token: string) {}
  },
  InputFile: class {},
  webhookCallback: vi.fn(),
}));

vi.mock("@grammyjs/runner", () => ({
  sequentialize: () => vi.fn(),
}));

const throttlerSpy = vi.fn(() => "throttler");
vi.mock("@grammyjs/transformer-throttler", () => ({
  apiThrottler: () => throttlerSpy(),
}));

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: (...args: Parameters<typeof undiciFetchSpy>) => undiciFetchSpy(...args),
  };
});

vi.mock("../../../src/media/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/media/store.js")>();
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

vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    }),
  };
});

vi.mock("../../../src/config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/sessions.js")>();
  return {
    ...actual,
    updateLastRoute: vi.fn(async () => undefined),
  };
});

vi.mock("../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn(async () => [] as string[]),
  upsertChannelPairingRequest: vi.fn(async () => ({
    code: "PAIRCODE",
    created: true,
  })),
}));

vi.mock("../../../src/auto-reply/reply.js", () => {
  const replySpy = vi.fn(async (_ctx, opts) => {
    await opts?.onReplyStart?.();
    return undefined;
  });
  return { getReplyFromConfig: replySpy, __replySpy: replySpy };
});
