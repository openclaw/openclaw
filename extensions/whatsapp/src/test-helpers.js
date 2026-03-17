import { vi } from "vitest";
import { createMockBaileys } from "../../../test/mocks/baileys.js";
const CONFIG_KEY = /* @__PURE__ */ Symbol.for("openclaw:testConfigMock");
const DEFAULT_CONFIG = {
  channels: {
    whatsapp: {
      // Tests can override; default remains open to avoid surprising fixtures
      allowFrom: ["*"]
    }
  },
  messages: {
    messagePrefix: void 0,
    responsePrefix: void 0
  }
};
if (!globalThis[CONFIG_KEY]) {
  globalThis[CONFIG_KEY] = () => DEFAULT_CONFIG;
}
function setLoadConfigMock(fn) {
  globalThis[CONFIG_KEY] = typeof fn === "function" ? fn : () => fn;
}
function resetLoadConfigMock() {
  globalThis[CONFIG_KEY] = () => DEFAULT_CONFIG;
}
vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig: () => {
      const getter = globalThis[CONFIG_KEY];
      if (typeof getter === "function") {
        return getter();
      }
      return DEFAULT_CONFIG;
    }
  };
});
vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig: () => {
      const getter = globalThis[CONFIG_KEY];
      if (typeof getter === "function") {
        return getter();
      }
      return DEFAULT_CONFIG;
    }
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
    value: vi.fn().mockImplementation(async (_buf, contentType) => ({
      id: "mid",
      path: "/tmp/mid",
      size: _buf.length,
      contentType
    }))
  });
  return mockModule;
});
vi.mock("@whiskeysockets/baileys", () => {
  const created = createMockBaileys();
  globalThis[/* @__PURE__ */ Symbol.for("openclaw:lastSocket")] = created.lastSocket;
  return created.mod;
});
vi.mock("qrcode-terminal", () => ({
  default: { generate: vi.fn() },
  generate: vi.fn()
}));
const baileys = await import("@whiskeysockets/baileys");
function resetBaileysMocks() {
  const recreated = createMockBaileys();
  globalThis[/* @__PURE__ */ Symbol.for("openclaw:lastSocket")] = recreated.lastSocket;
  const makeWASocket = vi.mocked(baileys.makeWASocket);
  const makeWASocketImpl = (...args) => recreated.mod.makeWASocket(...args);
  makeWASocket.mockReset();
  makeWASocket.mockImplementation(makeWASocketImpl);
  const useMultiFileAuthState = vi.mocked(baileys.useMultiFileAuthState);
  const useMultiFileAuthStateImpl = (...args) => recreated.mod.useMultiFileAuthState(
    ...args
  );
  useMultiFileAuthState.mockReset();
  useMultiFileAuthState.mockImplementation(useMultiFileAuthStateImpl);
  const fetchLatestBaileysVersion = vi.mocked(baileys.fetchLatestBaileysVersion);
  const fetchLatestBaileysVersionImpl = (...args) => recreated.mod.fetchLatestBaileysVersion(...args);
  fetchLatestBaileysVersion.mockReset();
  fetchLatestBaileysVersion.mockImplementation(fetchLatestBaileysVersionImpl);
  const makeCacheableSignalKeyStore = vi.mocked(baileys.makeCacheableSignalKeyStore);
  const makeCacheableSignalKeyStoreImpl = (...args) => recreated.mod.makeCacheableSignalKeyStore(...args);
  makeCacheableSignalKeyStore.mockReset();
  makeCacheableSignalKeyStore.mockImplementation(makeCacheableSignalKeyStoreImpl);
}
function getLastSocket() {
  const getter = globalThis[/* @__PURE__ */ Symbol.for("openclaw:lastSocket")];
  if (typeof getter === "function") {
    return getter();
  }
  if (!getter) {
    throw new Error("Baileys mock not initialized");
  }
  throw new Error("Invalid Baileys socket getter");
}
export {
  baileys,
  getLastSocket,
  resetBaileysMocks,
  resetLoadConfigMock,
  setLoadConfigMock
};
