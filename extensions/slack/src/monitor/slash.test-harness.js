import { vi } from "vitest";
const mocks = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  readAllowFromStoreMock: vi.fn(),
  upsertPairingRequestMock: vi.fn(),
  resolveAgentRouteMock: vi.fn(),
  finalizeInboundContextMock: vi.fn(),
  resolveConversationLabelMock: vi.fn(),
  createReplyPrefixOptionsMock: vi.fn(),
  recordSessionMetaFromInboundMock: vi.fn(),
  resolveStorePathMock: vi.fn()
}));
vi.mock("../../../../src/auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithDispatcher: (...args) => mocks.dispatchMock(...args)
}));
vi.mock("../../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args) => mocks.readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args) => mocks.upsertPairingRequestMock(...args)
}));
vi.mock("../../../../src/routing/resolve-route.js", () => ({
  resolveAgentRoute: (...args) => mocks.resolveAgentRouteMock(...args)
}));
vi.mock("../../../../src/auto-reply/reply/inbound-context.js", () => ({
  finalizeInboundContext: (...args) => mocks.finalizeInboundContextMock(...args)
}));
vi.mock("../../../../src/channels/conversation-label.js", () => ({
  resolveConversationLabel: (...args) => mocks.resolveConversationLabelMock(...args)
}));
vi.mock("../../../../src/channels/reply-prefix.js", () => ({
  createReplyPrefixOptions: (...args) => mocks.createReplyPrefixOptionsMock(...args)
}));
vi.mock("../../../../src/config/sessions.js", () => ({
  recordSessionMetaFromInbound: (...args) => mocks.recordSessionMetaFromInboundMock(...args),
  resolveStorePath: (...args) => mocks.resolveStorePathMock(...args)
}));
function getSlackSlashMocks() {
  return mocks;
}
function resetSlackSlashMocks() {
  mocks.dispatchMock.mockReset().mockResolvedValue({ counts: { final: 1, tool: 0, block: 0 } });
  mocks.readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  mocks.upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
  mocks.resolveAgentRouteMock.mockReset().mockReturnValue({
    agentId: "main",
    sessionKey: "session:1",
    accountId: "acct"
  });
  mocks.finalizeInboundContextMock.mockReset().mockImplementation((ctx) => ctx);
  mocks.resolveConversationLabelMock.mockReset().mockReturnValue(void 0);
  mocks.createReplyPrefixOptionsMock.mockReset().mockReturnValue({ onModelSelected: () => {
  } });
  mocks.recordSessionMetaFromInboundMock.mockReset().mockResolvedValue(void 0);
  mocks.resolveStorePathMock.mockReset().mockReturnValue("/tmp/openclaw-sessions.json");
}
export {
  getSlackSlashMocks,
  resetSlackSlashMocks
};
