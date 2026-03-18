import path from "node:path";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
import { resetInboundDedupe } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, vi, type Mock } from "vitest";

export const useSpy: Mock = vi.fn();
export const middlewareUseSpy: Mock = vi.fn();
export const onSpy: Mock = vi.fn();
export const stopSpy: Mock = vi.fn();
export const sendChatActionSpy: Mock = vi.fn();
function defaultUndiciFetch(input: RequestInfo | URL, init?: RequestInit) {
  return globalThis.fetch(input, init);
}

export const undiciFetchSpy: Mock = vi.fn(defaultUndiciFetch);

export function resetUndiciFetchMock() {
  undiciFetchSpy.mockReset();
  undiciFetchSpy.mockImplementation(defaultUndiciFetch);
}

type FetchRemoteMediaFn = typeof import("openclaw/plugin-sdk/media-runtime").fetchRemoteMedia;

async function defaultFetchRemoteMedia(
  params: Parameters<FetchRemoteMediaFn>[0],
): ReturnType<FetchRemoteMediaFn> {
  if (!params.fetchImpl) {
    throw new MediaFetchError("fetch_failed", `Missing fetchImpl for ${params.url}`);
  }
  const response = await params.fetchImpl(params.url, {
    redirect: "manual",
  });
  if (!response.ok) {
    throw new MediaFetchError(
      "http_error",
      `Failed to fetch media from ${params.url}: HTTP ${response.status} ${response.statusText}`,
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get("content-type") ?? undefined,
    fileName: params.filePathHint ? path.basename(params.filePathHint) : undefined,
  } as Awaited<ReturnType<FetchRemoteMediaFn>>;
}

export const fetchRemoteMediaSpy: Mock = vi.fn(defaultFetchRemoteMedia);

export function resetFetchRemoteMediaMock() {
  fetchRemoteMediaSpy.mockReset();
  fetchRemoteMediaSpy.mockImplementation(defaultFetchRemoteMedia);
}

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
};

const mediaHarnessReplySpy = vi.hoisted(() => vi.fn(async () => undefined));
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("openclaw/plugin-sdk/reply-runtime").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyHarnessParams = Parameters<DispatchReplyWithBufferedBlockDispatcherFn>[0];

let actualDispatchReplyWithBufferedBlockDispatcherPromise:
  | Promise<DispatchReplyWithBufferedBlockDispatcherFn>
  | undefined;

async function getActualDispatchReplyWithBufferedBlockDispatcher() {
  actualDispatchReplyWithBufferedBlockDispatcherPromise ??=
    import("../../../src/auto-reply/reply/provider-dispatcher.js").then(
      (module) =>
        module.dispatchReplyWithBufferedBlockDispatcher as DispatchReplyWithBufferedBlockDispatcherFn,
    );
  return await actualDispatchReplyWithBufferedBlockDispatcherPromise;
}

async function dispatchReplyWithBufferedBlockDispatcherViaActual(
  params: DispatchReplyHarnessParams,
) {
  const actualDispatchReplyWithBufferedBlockDispatcher =
    await getActualDispatchReplyWithBufferedBlockDispatcher();
  return await actualDispatchReplyWithBufferedBlockDispatcher({
    ...params,
    replyResolver: async (ctx, _cfg, opts) => {
      await opts?.onReplyStart?.();
      return await mediaHarnessReplySpy(ctx, opts);
    },
  });
}

const mediaHarnessDispatchReplyWithBufferedBlockDispatcher = vi.hoisted(() =>
  vi.fn<DispatchReplyWithBufferedBlockDispatcherFn>(
    dispatchReplyWithBufferedBlockDispatcherViaActual,
  ),
);
export const telegramBotDepsForTest = {
  loadConfig: () => ({
    channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
  }),
  resolveStorePath: vi.fn((storePath?: string) => storePath ?? "/tmp/telegram-media-sessions.json"),
  readChannelAllowFromStore: vi.fn(async () => [] as string[]),
  enqueueSystemEvent: vi.fn(),
  dispatchReplyWithBufferedBlockDispatcher: mediaHarnessDispatchReplyWithBufferedBlockDispatcher,
  listSkillCommandsForAgents: vi.fn(() => []),
  wasSentByBot: vi.fn(() => false),
};

beforeEach(() => {
  resetInboundDedupe();
  resetSaveMediaBufferMock();
  resetUndiciFetchMock();
  resetFetchRemoteMediaMock();
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
  Object.defineProperty(mockModule, "fetchRemoteMedia", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: (...args: Parameters<typeof fetchRemoteMediaSpy>) => fetchRemoteMediaSpy(...args),
  });
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
    updateLastRoute: vi.fn(async () => undefined),
  };
});

vi.doMock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-runtime")>();
  return {
    ...actual,
    findModelInCatalog: vi.fn(() => undefined),
    loadModelCatalog: vi.fn(async () => []),
    modelSupportsVision: vi.fn(() => false),
    resolveDefaultModelForAgent: vi.fn(() => ({
      provider: "openai",
      model: "gpt-test",
    })),
  };
});

vi.doMock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    readChannelAllowFromStore: vi.fn(async () => [] as string[]),
    upsertChannelPairingRequest: vi.fn(async () => ({
      code: "PAIRCODE",
      created: true,
    })),
  };
});

vi.doMock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
  return {
    ...actual,
    getReplyFromConfig: mediaHarnessReplySpy,
    __replySpy: mediaHarnessReplySpy,
  };
});
