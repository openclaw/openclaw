import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetLogger, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { monitorWebInbox } from "./inbound.js";

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

const sessionState = vi.hoisted(() => ({
  sock: undefined as MockSock | undefined,
}));

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

const sock: MockSock = createMockSock();
sessionState.sock = sock;

vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  const mockModule = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(mockModule, Object.getOwnPropertyDescriptors(actual));
  Object.defineProperty(mockModule, "saveMediaBuffer", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: vi.fn().mockResolvedValue({
      id: "mid",
      path: "/tmp/mid",
      size: 1,
      contentType: "image/jpeg",
    }),
  });
  return mockModule;
});

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  const mockModule = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(mockModule, Object.getOwnPropertyDescriptors(actual));
  Object.defineProperty(mockModule, "loadConfig", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: () => mockLoadConfig(),
  });
  return mockModule;
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  return {
    ...actual,
    readStoreAllowFromForDmPolicy: async (
      params: Parameters<typeof actual.readStoreAllowFromForDmPolicy>[0],
    ) =>
      await actual.readStoreAllowFromForDmPolicy({
        ...params,
        readStore: async (provider, accountId) =>
          (await readAllowFromStoreMock(provider, accountId)) as string[],
      }),
  };
});

vi.mock("./session.js", () => ({
  createWaSocket: vi.fn().mockImplementation(async () => {
    if (!sessionState.sock) {
      throw new Error("mock WhatsApp socket not initialized");
    }
    return sessionState.sock;
  }),
  waitForWaConnection: vi.fn().mockResolvedValue(undefined),
  getStatusCode: vi.fn(() => 500),
}));

export function getSock(): MockSock {
  return sock;
}

export type InboxOnMessage = NonNullable<Parameters<typeof monitorWebInbox>[0]["onMessage"]>;

export async function settleInboundWork() {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

export async function waitForMessageCalls(onMessage: ReturnType<typeof vi.fn>, count: number) {
  await vi.waitFor(
    () => {
      expect(onMessage).toHaveBeenCalledTimes(count);
    },
    { timeout: 2_000, interval: 5 },
  );
}

export async function startInboxMonitor(onMessage: InboxOnMessage) {
  const listener = await monitorWebInbox({
    verbose: false,
    onMessage,
    accountId: DEFAULT_ACCOUNT_ID,
    authDir: getAuthDir(),
  });
  return { listener, sock: getSock() };
}

export function buildNotifyMessageUpsert(params: {
  id: string;
  remoteJid: string;
  text: string;
  timestamp: number;
  pushName?: string;
  participant?: string;
}) {
  return {
    type: "notify",
    messages: [
      {
        key: {
          id: params.id,
          fromMe: false,
          remoteJid: params.remoteJid,
          participant: params.participant,
        },
        message: { conversation: params.text },
        messageTimestamp: params.timestamp,
        pushName: params.pushName,
      },
    ],
  };
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
