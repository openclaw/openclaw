import { vi } from "vitest";
import { parsePluginBindingApprovalCustomId } from "../../../../src/plugins/conversation-binding.js";
import { resolvePinnedMainDmOwnerFromAllowlist } from "../../../../src/security/dm-policy-shared.js";

const runtimeMocks = vi.hoisted(() => ({
  buildPluginBindingResolvedTextMock: vi.fn(),
  readAllowFromStoreMock: vi.fn(),
  recordInboundSessionMock: vi.fn(),
  resolvePluginConversationBindingApprovalMock: vi.fn(),
  upsertPairingRequestMock: vi.fn(),
}));

export const readAllowFromStoreMock = runtimeMocks.readAllowFromStoreMock;
export const upsertPairingRequestMock = runtimeMocks.upsertPairingRequestMock;
export const recordInboundSessionMock = runtimeMocks.recordInboundSessionMock;
export const resolvePluginConversationBindingApprovalMock =
  runtimeMocks.resolvePluginConversationBindingApprovalMock;
export const buildPluginBindingResolvedTextMock = runtimeMocks.buildPluginBindingResolvedTextMock;

async function readStoreAllowFromForDmPolicy(params: {
  provider: string;
  accountId: string;
  dmPolicy?: string | null;
  shouldRead?: boolean | null;
}) {
  if (params.shouldRead === false || params.dmPolicy === "allowlist") {
    return [];
  }
  return await readAllowFromStoreMock(params.provider, params.accountId);
}

vi.mock("../monitor/agent-components-helpers.runtime.js", () => {
  return {
    readStoreAllowFromForDmPolicy,
    resolvePinnedMainDmOwnerFromAllowlist,
    upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
  };
});

vi.mock("../monitor/agent-components.runtime.js", () => {
  return {
    buildPluginBindingResolvedText: (...args: unknown[]) =>
      buildPluginBindingResolvedTextMock(...args),
    parsePluginBindingApprovalCustomId,
    recordInboundSession: (...args: unknown[]) => recordInboundSessionMock(...args),
    resolvePluginConversationBindingApproval: (...args: unknown[]) =>
      resolvePluginConversationBindingApprovalMock(...args),
  };
});

export function resetDiscordComponentRuntimeMocks() {
  readAllowFromStoreMock.mockClear().mockResolvedValue([]);
  upsertPairingRequestMock.mockClear().mockResolvedValue({ code: "PAIRCODE", created: true });
  recordInboundSessionMock.mockClear().mockResolvedValue(undefined);
  resolvePluginConversationBindingApprovalMock.mockReset().mockResolvedValue({
    status: "approved",
    binding: {
      bindingId: "binding-1",
      pluginId: "openclaw-codex-app-server",
      pluginName: "OpenClaw App Server",
      pluginRoot: "/plugins/codex",
      channel: "discord",
      accountId: "default",
      conversationId: "user:123456789",
      boundAt: Date.now(),
    },
    request: {
      id: "approval-1",
      pluginId: "openclaw-codex-app-server",
      pluginName: "OpenClaw App Server",
      pluginRoot: "/plugins/codex",
      requestedAt: Date.now(),
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:123456789",
      },
    },
    decision: "allow-once",
  });
  buildPluginBindingResolvedTextMock.mockReset().mockReturnValue("Binding approved.");
}
