import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../../../src/logging.js";

// Avoid exporting vitest mock types (TS2742 under pnpm + d.ts emit).
// oxlint-disable-next-line typescript/no-explicit-any
type AnyMockFn = any;

export const DEFAULT_ACCOUNT_ID = "default";

export const DEFAULT_WEB_INBOX_CONFIG = {
  channels: {
    whatsapp: {
      // Allow all in tests by default.
      allowFrom: ["*"],
    },
  },
  messages: {
    messagePrefix: undefined,
    responsePrefix: undefined,
  },
} as const;

export const mockLoadConfig: AnyMockFn = vi.fn().mockReturnValue(DEFAULT_WEB_INBOX_CONFIG);

export const readAllowFromStoreMock: AnyMockFn = vi.fn().mockResolvedValue([]);
export const upsertPairingRequestMock: AnyMockFn = vi
  .fn()
  .mockResolvedValue({ code: "PAIRCODE", created: true });

export type MockSock = {
  ev: EventEmitter;
  ws: { close: AnyMockFn };
  sendPresenceUpdate: AnyMockFn;
  sendMessage: AnyMockFn;
  readMessages: AnyMockFn;
  updateMediaMessage: AnyMockFn;
  logger: Record<string, unknown>;
  signalRepository: {
    lidMapping: {
      getPNForLID: AnyMockFn;
    };
  };
  user: { id: string };
};

function createResolvedMock() {
  return vi.fn().mockResolvedValue(undefined);
}

function createMockSock(): MockSock {
  const ev = new EventEmitter();
  return {
    ev,
    ws: { close: vi.fn() },
    sendPresenceUpdate: createResolvedMock(),
    sendMessage: createResolvedMock(),
    readMessages: createResolvedMock(),
    updateMediaMessage: vi.fn(),
    logger: {},
    signalRepository: {
      lidMapping: {
        getPNForLID: vi.fn().mockResolvedValue(null),
      },
    },
    user: { id: "123@s.whatsapp.net" },
  };
}

function getPairingStoreMocks() {
  const readChannelAllowFromStore = (...args: unknown[]) => readAllowFromStoreMock(...args);
  const upsertChannelPairingRequest = (...args: unknown[]) => upsertPairingRequestMock(...args);
  return {
    readChannelAllowFromStore,
    upsertChannelPairingRequest,
  };
}

const sock: MockSock = createMockSock();

vi.mock("../../../src/media/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/media/store.js")>();
  return {
    ...actual,
    saveMediaBuffer: vi.fn().mockResolvedValue({
      id: "mid",
      path: "/tmp/mid",
      size: 1,
      contentType: "image/jpeg",
    }),
  };
});

vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/config.js")>();
  return {
    ...actual,
    loadConfig: () => mockLoadConfig(),
  };
});

vi.mock("../../../src/pairing/pairing-store.js", () => getPairingStoreMocks());

vi.mock("./session.js", () => ({
  createWaSocket: vi.fn().mockResolvedValue(sock),
  waitForWaConnection: vi.fn().mockResolvedValue(undefined),
  getStatusCode: vi.fn(() => 500),
}));

export function getSock(): MockSock {
  return sock;
}

export function expectPairingPromptSent(sock: MockSock, jid: string, senderE164: string) {
  expect(sock.sendMessage).toHaveBeenCalledTimes(1);
  expect(sock.sendMessage).toHaveBeenCalledWith(jid, {
    text: expect.stringContaining(`Your WhatsApp phone number: ${senderE164}`),
  });
  expect(sock.sendMessage).toHaveBeenCalledWith(jid, {
    text: expect.stringContaining("Pairing code: PAIRCODE"),
  });
}

let authDir: string | undefined;

export function getAuthDir(): string {
  if (!authDir) {
    throw new Error("authDir not initialized; call installWebMonitorInboxUnitTestHooks()");
  }
  return authDir;
}

export function installWebMonitorInboxUnitTestHooks(opts?: { authDir?: boolean }) {
  const createAuthDir = opts?.authDir ?? true;

  beforeEach(async () => {
    sock.ev = new EventEmitter();
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(DEFAULT_WEB_INBOX_CONFIG);
    readAllowFromStoreMock.mockResolvedValue([]);
    upsertPairingRequestMock.mockResolvedValue({
      code: "PAIRCODE",
      created: true,
    });
    const { resetWebInboundDedupe } = await import("./inbound.js");
    resetWebInboundDedupe();
    if (createAuthDir) {
      authDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
    } else {
      authDir = undefined;
    }
  });

  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
    if (authDir) {
      fsSync.rmSync(authDir, { recursive: true, force: true });
      authDir = undefined;
    }
  });
}
