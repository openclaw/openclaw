// External WhatsApp transport fixtures; channel policy executes its real owners.
import { vi } from "vitest";
import type { MockBaileysSocket } from "../../../test/mocks/baileys.js";
import { createMockBaileys } from "../../../test/mocks/baileys.js";

// Use globalThis to store the mock config so it survives vi.mock hoisting
const CONFIG_KEY = Symbol.for("openclaw:testConfigMock");
const DEFAULT_CONFIG = {
  channels: {
    whatsapp: {
      // Tests can override; default remains open to avoid surprising fixtures
      allowFrom: ["*"],
    },
  },
  messages: {
    messagePrefix: undefined,
    responsePrefix: undefined,
  },
};

// Initialize default if not set
if (!(globalThis as Record<symbol, unknown>)[CONFIG_KEY]) {
  (globalThis as Record<symbol, unknown>)[CONFIG_KEY] = () => DEFAULT_CONFIG;
}
export function setLoadConfigMock(fn: unknown) {
  (globalThis as Record<symbol, unknown>)[CONFIG_KEY] = typeof fn === "function" ? fn : () => fn;
}

export function resetLoadConfigMock() {
  (globalThis as Record<symbol, unknown>)[CONFIG_KEY] = () => DEFAULT_CONFIG;
}

vi.mock("./auto-reply/config.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auto-reply/config.runtime.js")>()),
  getRuntimeConfig: () => {
    const load = (globalThis as Record<symbol, unknown>)[Symbol.for("openclaw:testConfigMock")];
    if (typeof load !== "function") {
      throw new Error("Missing WhatsApp test config");
    }
    return load();
  },
}));

vi.mock("./inbound/runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inbound/runtime-api.js")>()),
  downloadMediaMessage: vi.fn().mockResolvedValue(Buffer.from("img")),
}));

vi.mock("./session.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session.runtime.js")>();
  const created = createMockBaileys();
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw:lastSocket")] =
    created.lastSocket;
  return {
    ...actual,
    ...created.mod,
    BufferJSON: actual.BufferJSON,
  };
});

vi.mock("./qr-terminal.js", () => ({
  renderQrTerminal: vi.fn(async () => "ASCII-QR"),
}));

export const baileys = await import("./session.runtime.js");

function resetMockExport<T extends (...args: never[]) => unknown>(params: {
  current: T;
  implementation: T;
}) {
  if (!("mockReset" in params.current) || typeof params.current.mockReset !== "function") {
    return;
  }
  params.current.mockReset();
  if (
    "mockImplementation" in params.current &&
    typeof params.current.mockImplementation === "function"
  ) {
    params.current.mockImplementation(params.implementation);
  }
}

export function resetBaileysMocks() {
  const recreated = createMockBaileys();
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw:lastSocket")] =
    recreated.lastSocket;

  const makeWASocket = vi.mocked(baileys.makeWASocket);
  const makeWASocketImpl: typeof baileys.makeWASocket = (...args) =>
    (recreated.mod.makeWASocket as unknown as typeof baileys.makeWASocket)(...args);
  resetMockExport({
    current: makeWASocket,
    implementation: makeWASocketImpl,
  });

  const useMultiFileAuthState = vi.mocked(baileys.useMultiFileAuthState);
  const useMultiFileAuthStateImpl: typeof baileys.useMultiFileAuthState = (...args) =>
    (recreated.mod.useMultiFileAuthState as unknown as typeof baileys.useMultiFileAuthState)(
      ...args,
    );
  resetMockExport({
    current: useMultiFileAuthState,
    implementation: useMultiFileAuthStateImpl,
  });

  const fetchLatestBaileysVersion = vi.mocked(baileys.fetchLatestBaileysVersion);
  const fetchLatestBaileysVersionImpl: typeof baileys.fetchLatestBaileysVersion = (...args) =>
    (
      recreated.mod.fetchLatestBaileysVersion as unknown as typeof baileys.fetchLatestBaileysVersion
    )(...args);
  resetMockExport({
    current: fetchLatestBaileysVersion,
    implementation: fetchLatestBaileysVersionImpl,
  });

  const makeCacheableSignalKeyStore = vi.mocked(baileys.makeCacheableSignalKeyStore);
  const makeCacheableSignalKeyStoreImpl: typeof baileys.makeCacheableSignalKeyStore = (...args) =>
    (
      recreated.mod
        .makeCacheableSignalKeyStore as unknown as typeof baileys.makeCacheableSignalKeyStore
    )(...args);
  resetMockExport({
    current: makeCacheableSignalKeyStore,
    implementation: makeCacheableSignalKeyStoreImpl,
  });
}

export function getLastSocket(): MockBaileysSocket {
  const getter = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw:lastSocket")];
  if (typeof getter === "function") {
    return (getter as () => MockBaileysSocket)();
  }
  if (!getter) {
    throw new Error("Baileys mock not initialized");
  }
  throw new Error("Invalid Baileys socket getter");
}
