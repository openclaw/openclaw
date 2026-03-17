import { vi } from "vitest";
const sendMock = vi.fn();
const reactMock = vi.fn();
const updateLastRouteMock = vi.fn();
const dispatchMock = vi.fn();
const readAllowFromStoreMock = vi.fn();
const upsertPairingRequestMock = vi.fn();
vi.mock("./send.js", () => ({
  sendMessageDiscord: (...args) => sendMock(...args),
  reactMessageDiscord: async (...args) => {
    reactMock(...args);
  }
}));
vi.mock("../../../src/auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    dispatchInboundMessage: (...args) => dispatchMock(...args),
    dispatchInboundMessageWithDispatcher: (...args) => dispatchMock(...args),
    dispatchInboundMessageWithBufferedDispatcher: (...args) => dispatchMock(...args)
  };
});
function createPairingStoreMocks() {
  return {
    readChannelAllowFromStore(...args) {
      return readAllowFromStoreMock(...args);
    },
    upsertChannelPairingRequest(...args) {
      return upsertPairingRequestMock(...args);
    }
  };
}
vi.mock("../../../src/pairing/pairing-store.js", () => createPairingStoreMocks());
vi.mock("../../../src/config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveStorePath: vi.fn(() => "/tmp/openclaw-sessions.json"),
    updateLastRoute: (...args) => updateLastRouteMock(...args),
    resolveSessionKey: vi.fn()
  };
});
export {
  dispatchMock,
  reactMock,
  readAllowFromStoreMock,
  sendMock,
  updateLastRouteMock,
  upsertPairingRequestMock
};
