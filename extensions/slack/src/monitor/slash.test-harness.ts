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
  resolveStorePathMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
  return {
    ...actual,
    dispatchReplyWithDispatcher: (...args: unknown[]) => mocks.dispatchMock(...args),
    finalizeInboundContext: (...args: unknown[]) => mocks.finalizeInboundContextMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    readChannelAllowFromStore: (...args: unknown[]) => mocks.readAllowFromStoreMock(...args),
    upsertChannelPairingRequest: (...args: unknown[]) => mocks.upsertPairingRequestMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/routing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/routing")>();
  return {
    ...actual,
    resolveAgentRoute: (...args: unknown[]) => mocks.resolveAgentRouteMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/channel-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-runtime")>();
  return {
    ...actual,
    resolveConversationLabel: (...args: unknown[]) => mocks.resolveConversationLabelMock(...args),
    createReplyPrefixOptions: (...args: unknown[]) => mocks.createReplyPrefixOptionsMock(...args),
    recordInboundSessionMetaSafe: (...args: unknown[]) =>
      mocks.recordSessionMetaFromInboundMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    recordSessionMetaFromInbound: (...args: unknown[]) =>
      mocks.recordSessionMetaFromInboundMock(...args),
    resolveStorePath: (...args: unknown[]) => mocks.resolveStorePathMock(...args),
  };
});

type SlashHarnessMocks = {
  dispatchMock: ReturnType<typeof vi.fn>;
  readAllowFromStoreMock: ReturnType<typeof vi.fn>;
  upsertPairingRequestMock: ReturnType<typeof vi.fn>;
  resolveAgentRouteMock: ReturnType<typeof vi.fn>;
  finalizeInboundContextMock: ReturnType<typeof vi.fn>;
  resolveConversationLabelMock: ReturnType<typeof vi.fn>;
  createReplyPrefixOptionsMock: ReturnType<typeof vi.fn>;
  recordSessionMetaFromInboundMock: ReturnType<typeof vi.fn>;
  resolveStorePathMock: ReturnType<typeof vi.fn>;
};

export function getSlackSlashMocks(): SlashHarnessMocks {
  return mocks;
}

export function resetSlackSlashMocks() {
  mocks.dispatchMock.mockReset().mockResolvedValue({ counts: { final: 1, tool: 0, block: 0 } });
  mocks.readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  mocks.upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
  mocks.resolveAgentRouteMock.mockReset().mockReturnValue({
    agentId: "main",
    sessionKey: "session:1",
    accountId: "acct",
  });
  mocks.finalizeInboundContextMock.mockReset().mockImplementation((ctx: unknown) => ctx);
  mocks.resolveConversationLabelMock.mockReset().mockReturnValue(undefined);
  mocks.createReplyPrefixOptionsMock.mockReset().mockReturnValue({ onModelSelected: () => {} });
  mocks.recordSessionMetaFromInboundMock.mockReset().mockResolvedValue(undefined);
  mocks.resolveStorePathMock.mockReset().mockReturnValue("/tmp/openclaw-sessions.json");
}
