import { beforeEach, vi } from "vitest";
import { resetInboundDedupe } from "../../../src/auto-reply/reply/inbound-dedupe.js";
const useSpy = vi.fn();
const middlewareUseSpy = vi.fn();
const onSpy = vi.fn();
const stopSpy = vi.fn();
const sendChatActionSpy = vi.fn();
const undiciFetchSpy = vi.fn(
  (input, init) => globalThis.fetch(input, init)
);
async function defaultSaveMediaBuffer(buffer, contentType) {
  return {
    id: "media",
    path: "/tmp/telegram-media",
    size: buffer.byteLength,
    contentType: contentType ?? "application/octet-stream"
  };
}
const saveMediaBufferSpy = vi.fn(defaultSaveMediaBuffer);
function setNextSavedMediaPath(params) {
  saveMediaBufferSpy.mockImplementationOnce(
    async (buffer, detectedContentType) => ({
      id: params.id ?? "media",
      path: params.path,
      size: params.size ?? buffer.byteLength,
      contentType: params.contentType ?? detectedContentType ?? "application/octet-stream"
    })
  );
}
function resetSaveMediaBufferMock() {
  saveMediaBufferSpy.mockReset();
  saveMediaBufferSpy.mockImplementation(defaultSaveMediaBuffer);
}
const apiStub = {
  config: { use: useSpy },
  sendChatAction: sendChatActionSpy,
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  setMyCommands: vi.fn(async () => void 0)
};
beforeEach(() => {
  resetInboundDedupe();
  resetSaveMediaBufferMock();
});
vi.mock("grammy", () => ({
  Bot: class {
    constructor(token) {
      this.token = token;
      this.api = apiStub;
      this.use = middlewareUseSpy;
      this.on = onSpy;
      this.command = vi.fn();
      this.stop = stopSpy;
      this.catch = vi.fn();
    }
  },
  InputFile: class {
  },
  webhookCallback: vi.fn()
}));
vi.mock("@grammyjs/runner", () => ({
  sequentialize: () => vi.fn()
}));
const throttlerSpy = vi.fn(() => "throttler");
vi.mock("@grammyjs/transformer-throttler", () => ({
  apiThrottler: () => throttlerSpy()
}));
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetch: (...args) => undiciFetchSpy(...args)
  };
});
vi.mock("../../../src/media/store.js", async (importOriginal) => {
  const actual = await importOriginal();
  const mockModule = /* @__PURE__ */ Object.create(null);
  Object.defineProperties(mockModule, Object.getOwnPropertyDescriptors(actual));
  Object.defineProperty(mockModule, "saveMediaBuffer", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: (...args) => saveMediaBufferSpy(...args)
  });
  return mockModule;
});
vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig: () => ({
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } }
    })
  };
});
vi.mock("../../../src/config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    updateLastRoute: vi.fn(async () => void 0)
  };
});
vi.mock("../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn(async () => []),
  upsertChannelPairingRequest: vi.fn(async () => ({
    code: "PAIRCODE",
    created: true
  }))
}));
vi.mock("../../../src/auto-reply/reply.js", () => {
  const replySpy = vi.fn(async (_ctx, opts) => {
    await opts?.onReplyStart?.();
    return void 0;
  });
  return { getReplyFromConfig: replySpy, __replySpy: replySpy };
});
export {
  middlewareUseSpy,
  onSpy,
  resetSaveMediaBufferMock,
  sendChatActionSpy,
  setNextSavedMediaPath,
  stopSpy,
  undiciFetchSpy,
  useSpy
};
