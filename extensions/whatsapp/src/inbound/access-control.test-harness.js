import { beforeEach, vi } from "vitest";
const sendMessageMock = vi.fn();
const readAllowFromStoreMock = vi.fn();
const upsertPairingRequestMock = vi.fn();
let config = {};
function setAccessControlTestConfig(next) {
  config = next;
}
function setupAccessControlTestHarness() {
  beforeEach(() => {
    config = {
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: []
        }
      }
    };
    sendMessageMock.mockReset().mockResolvedValue(void 0);
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
  });
}
vi.mock("../../../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig: () => config
  };
});
vi.mock("../../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args) => readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args) => upsertPairingRequestMock(...args)
}));
export {
  readAllowFromStoreMock,
  sendMessageMock,
  setAccessControlTestConfig,
  setupAccessControlTestHarness,
  upsertPairingRequestMock
};
