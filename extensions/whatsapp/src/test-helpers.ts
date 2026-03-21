import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

function normalizeAgentIdForStorePath(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return "main";
  }
  return (
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, 64) || "main"
  );
}

function resolveStorePathFallback(store?: string, opts?: { agentId?: string }): string {
  const agentId = normalizeAgentIdForStorePath(opts?.agentId);
  if (!store) {
    return path.resolve(
      process.env.HOME ?? os.homedir(),
      ".openclaw",
      "agents",
      agentId,
      "sessions",
      "sessions.json",
    );
  }
  if (store.includes("{agentId}")) {
    return path.resolve(store.replaceAll("{agentId}", agentId));
  }
  if (store.startsWith("~")) {
    return path.resolve(path.join(process.env.HOME ?? os.homedir(), store.slice(1)));
  }
  return path.resolve(store);
}

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  const mockModule = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(mockModule, Object.getOwnPropertyDescriptors(actual));
  Object.defineProperties(mockModule, {
    loadConfig: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: () => {
        const getter = (globalThis as Record<symbol, unknown>)[CONFIG_KEY];
        if (typeof getter === "function") {
          return getter();
        }
        return DEFAULT_CONFIG;
      },
    },
    updateLastRoute: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: async (params: {
        storePath: string;
        sessionKey: string;
        deliveryContext: { channel: string; to: string; accountId?: string };
      }) => {
        const raw = await fs.readFile(params.storePath, "utf8").catch(() => "{}");
        const store = JSON.parse(raw) as Record<string, Record<string, unknown>>;
        const current = store[params.sessionKey] ?? {};
        store[params.sessionKey] = {
          ...current,
          lastChannel: params.deliveryContext.channel,
          lastTo: params.deliveryContext.to,
          lastAccountId: params.deliveryContext.accountId,
        };
        await fs.writeFile(params.storePath, JSON.stringify(store));
      },
    },
    loadSessionStore: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: (storePath: string) => {
        try {
          return JSON.parse(fsSync.readFileSync(storePath, "utf8")) as Record<string, unknown>;
        } catch {
          return {};
        }
      },
    },
    recordSessionMetaFromInbound: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: async () => undefined,
    },
    resolveStorePath: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: actual.resolveStorePath ?? resolveStorePathFallback,
    },
  });
  return mockModule;
});

// Some web modules live under `src/web/auto-reply/*` and import config via a different
// relative path (`../../config/config.js`). Mock both specifiers so tests stay stable
// across refactors that move files between folders.
vi.mock("../../config/config.js", async (importOriginal) => {
  // `../../config/config.js` is correct for modules under `src/web/auto-reply/*`.
  // For typing in this file (which lives in `src/web/*`), refer to the same module
  // via the local relative path.
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  const mockModule = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(mockModule, Object.getOwnPropertyDescriptors(actual));
  Object.defineProperty(mockModule, "loadConfig", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: () => {
      const getter = (globalThis as Record<symbol, unknown>)[CONFIG_KEY];
      if (typeof getter === "function") {
        return getter();
      }
      return DEFAULT_CONFIG;
    },
  });
  return mockModule;
});

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  const mockModule = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(mockModule, Object.getOwnPropertyDescriptors(actual));
  Object.defineProperty(mockModule, "saveMediaBuffer", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: vi.fn().mockImplementation(async (_buf: Buffer, contentType?: string) => ({
      id: "mid",
      path: "/tmp/mid",
      size: _buf.length,
      contentType,
    })),
  });
  return mockModule;
});

vi.mock("openclaw/plugin-sdk/state-paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/state-paths")>();
  return {
    ...actual,
    resolveOAuthDir: () => "/tmp/openclaw-oauth",
  };
});

vi.mock("@whiskeysockets/baileys", () => {
  const created = createMockBaileys();
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw:lastSocket")] =
    created.lastSocket;
  return created.mod;
});

vi.mock("qrcode-terminal", () => ({
  default: { generate: vi.fn() },
  generate: vi.fn(),
}));

export const baileys = await import("@whiskeysockets/baileys");

export function resetBaileysMocks() {
  const recreated = createMockBaileys();
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw:lastSocket")] =
    recreated.lastSocket;

  const makeWASocket = vi.mocked(baileys.makeWASocket);
  const makeWASocketImpl: typeof baileys.makeWASocket = (...args) =>
    (recreated.mod.makeWASocket as unknown as typeof baileys.makeWASocket)(...args);
  makeWASocket.mockReset();
  makeWASocket.mockImplementation(makeWASocketImpl);

  const useMultiFileAuthState = vi.mocked(baileys.useMultiFileAuthState);
  const useMultiFileAuthStateImpl: typeof baileys.useMultiFileAuthState = (...args) =>
    (recreated.mod.useMultiFileAuthState as unknown as typeof baileys.useMultiFileAuthState)(
      ...args,
    );
  useMultiFileAuthState.mockReset();
  useMultiFileAuthState.mockImplementation(useMultiFileAuthStateImpl);

  const fetchLatestBaileysVersion = vi.mocked(baileys.fetchLatestBaileysVersion);
  const fetchLatestBaileysVersionImpl: typeof baileys.fetchLatestBaileysVersion = (...args) =>
    (
      recreated.mod.fetchLatestBaileysVersion as unknown as typeof baileys.fetchLatestBaileysVersion
    )(...args);
  fetchLatestBaileysVersion.mockReset();
  fetchLatestBaileysVersion.mockImplementation(fetchLatestBaileysVersionImpl);

  const makeCacheableSignalKeyStore = vi.mocked(baileys.makeCacheableSignalKeyStore);
  const makeCacheableSignalKeyStoreImpl: typeof baileys.makeCacheableSignalKeyStore = (...args) =>
    (
      recreated.mod
        .makeCacheableSignalKeyStore as unknown as typeof baileys.makeCacheableSignalKeyStore
    )(...args);
  makeCacheableSignalKeyStore.mockReset();
  makeCacheableSignalKeyStore.mockImplementation(makeCacheableSignalKeyStoreImpl);
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
