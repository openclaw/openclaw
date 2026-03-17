import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../../../src/logging.js";
const DEFAULT_ACCOUNT_ID = "default";
const DEFAULT_WEB_INBOX_CONFIG = {
  channels: {
    whatsapp: {
      // Allow all in tests by default.
      allowFrom: ["*"]
    }
  },
  messages: {
    messagePrefix: void 0,
    responsePrefix: void 0
  }
};
const mockLoadConfig = vi.fn().mockReturnValue(DEFAULT_WEB_INBOX_CONFIG);
const readAllowFromStoreMock = vi.fn().mockResolvedValue([]);
const upsertPairingRequestMock = vi.fn().mockResolvedValue({ code: "PAIRCODE", created: true });
function createResolvedMock() {
  return vi.fn().mockResolvedValue(void 0);
}
function createMockSock() {
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
        getPNForLID: vi.fn().mockResolvedValue(null)
      }
    },
    user: { id: "123@s.whatsapp.net" }
  };
}
function getPairingStoreMocks() {
  const readChannelAllowFromStore = (...args) => readAllowFromStoreMock(...args);
  const upsertChannelPairingRequest = (...args) => upsertPairingRequestMock(...args);
  return {
    readChannelAllowFromStore,
    upsertChannelPairingRequest
  };
}
const sock = createMockSock();
vi.mock("../../../src/media/store.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    saveMediaBuffer: vi.fn().mockResolvedValue({
      id: "mid",
      path: "/tmp/mid",
      size: 1,
      contentType: "image/jpeg"
    })
  };
});
vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig: () => mockLoadConfig()
  };
});
vi.mock("../../../src/pairing/pairing-store.js", () => getPairingStoreMocks());
vi.mock("./session.js", () => ({
  createWaSocket: vi.fn().mockResolvedValue(sock),
  waitForWaConnection: vi.fn().mockResolvedValue(void 0),
  getStatusCode: vi.fn(() => 500)
}));
function getSock() {
  return sock;
}
function expectPairingPromptSent(sock2, jid, senderE164) {
  expect(sock2.sendMessage).toHaveBeenCalledTimes(1);
  expect(sock2.sendMessage).toHaveBeenCalledWith(jid, {
    text: expect.stringContaining(`Your WhatsApp phone number: ${senderE164}`)
  });
  expect(sock2.sendMessage).toHaveBeenCalledWith(jid, {
    text: expect.stringContaining("Pairing code: PAIRCODE")
  });
}
let authDir;
function getAuthDir() {
  if (!authDir) {
    throw new Error("authDir not initialized; call installWebMonitorInboxUnitTestHooks()");
  }
  return authDir;
}
function installWebMonitorInboxUnitTestHooks(opts) {
  const createAuthDir = opts?.authDir ?? true;
  beforeEach(async () => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(DEFAULT_WEB_INBOX_CONFIG);
    readAllowFromStoreMock.mockResolvedValue([]);
    upsertPairingRequestMock.mockResolvedValue({
      code: "PAIRCODE",
      created: true
    });
    const { resetWebInboundDedupe } = await import("./inbound.js");
    resetWebInboundDedupe();
    if (createAuthDir) {
      authDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
    } else {
      authDir = void 0;
    }
  });
  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
    vi.useRealTimers();
    if (authDir) {
      fsSync.rmSync(authDir, { recursive: true, force: true });
      authDir = void 0;
    }
  });
}
export {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_WEB_INBOX_CONFIG,
  expectPairingPromptSent,
  getAuthDir,
  getSock,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
  readAllowFromStoreMock,
  upsertPairingRequestMock
};
