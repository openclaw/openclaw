import { beforeEach, vi } from "vitest";
import { resetInboundDedupe } from "../../../src/auto-reply/reply/inbound-dedupe.js";
import { resetSystemEventsForTest } from "../../../src/infra/system-events.js";
const waitForTransportReadyMock = vi.hoisted(() => vi.fn());
const sendMock = vi.hoisted(() => vi.fn());
const replyMock = vi.hoisted(() => vi.fn());
const updateLastRouteMock = vi.hoisted(() => vi.fn());
const readAllowFromStoreMock = vi.hoisted(() => vi.fn());
const upsertPairingRequestMock = vi.hoisted(() => vi.fn());
const streamMock = vi.hoisted(() => vi.fn());
const signalCheckMock = vi.hoisted(() => vi.fn());
const signalRpcRequestMock = vi.hoisted(() => vi.fn());
const spawnSignalDaemonMock = vi.hoisted(() => vi.fn());
function getSignalToolResultTestMocks() {
  return {
    waitForTransportReadyMock,
    sendMock,
    replyMock,
    updateLastRouteMock,
    readAllowFromStoreMock,
    upsertPairingRequestMock,
    streamMock,
    signalCheckMock,
    signalRpcRequestMock,
    spawnSignalDaemonMock
  };
}
let config = {};
function setSignalToolResultTestConfig(next) {
  config = next;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function createMockSignalDaemonHandle(overrides = {}) {
  const stop = overrides.stop ?? vi.fn();
  const exited = overrides.exited ?? new Promise(() => {
  });
  const isExited = overrides.isExited ?? (() => false);
  return {
    stop,
    exited,
    isExited
  };
}
vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig: () => config
  };
});
vi.mock("../../../src/auto-reply/reply.js", () => ({
  getReplyFromConfig: (...args) => replyMock(...args)
}));
vi.mock("./send.js", () => ({
  sendMessageSignal: (...args) => sendMock(...args),
  sendTypingSignal: vi.fn().mockResolvedValue(true),
  sendReadReceiptSignal: vi.fn().mockResolvedValue(true)
}));
vi.mock("../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args) => readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args) => upsertPairingRequestMock(...args)
}));
vi.mock("../../../src/config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveStorePath: vi.fn(() => "/tmp/openclaw-sessions.json"),
    updateLastRoute: (...args) => updateLastRouteMock(...args),
    readSessionUpdatedAt: vi.fn(() => void 0),
    recordSessionMetaFromInbound: vi.fn().mockResolvedValue(void 0)
  };
});
vi.mock("./client.js", () => ({
  streamSignalEvents: (...args) => streamMock(...args),
  signalCheck: (...args) => signalCheckMock(...args),
  signalRpcRequest: (...args) => signalRpcRequestMock(...args)
}));
vi.mock("./daemon.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSignalDaemon: (...args) => spawnSignalDaemonMock(...args)
  };
});
vi.mock("../../../src/infra/transport-ready.js", () => ({
  waitForTransportReady: (...args) => waitForTransportReadyMock(...args)
}));
function installSignalToolResultTestHooks() {
  beforeEach(() => {
    resetInboundDedupe();
    config = {
      messages: { responsePrefix: "PFX" },
      channels: {
        signal: { autoStart: false, dmPolicy: "open", allowFrom: ["*"] }
      }
    };
    sendMock.mockReset().mockResolvedValue(void 0);
    replyMock.mockReset();
    updateLastRouteMock.mockReset();
    streamMock.mockReset();
    signalCheckMock.mockReset().mockResolvedValue({});
    signalRpcRequestMock.mockReset().mockResolvedValue({});
    spawnSignalDaemonMock.mockReset().mockReturnValue(createMockSignalDaemonHandle());
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
    waitForTransportReadyMock.mockReset().mockResolvedValue(void 0);
    resetSystemEventsForTest();
  });
}
export {
  config,
  createMockSignalDaemonHandle,
  flush,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig
};
