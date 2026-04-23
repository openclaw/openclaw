import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks used across tests so vi.mock factories can reference them.
const { resolvePolicyMock, buildContextMock } = vi.hoisted(() => ({
  resolvePolicyMock: vi.fn(),
  buildContextMock: vi.fn(),
}));

vi.mock("../../inbound-policy.js", () => ({
  resolveWhatsAppCommandAuthorized: async () => true,
  resolveWhatsAppInboundPolicy: resolvePolicyMock,
}));

vi.mock("./inbound-dispatch.js", () => ({
  buildWhatsAppInboundContext: buildContextMock,
  dispatchWhatsAppBufferedReply: async () => ({
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  }),
  resolveWhatsAppDmRouteTarget: () => null,
  resolveWhatsAppResponsePrefix: () => undefined,
  updateWhatsAppMainLastRoute: () => {},
}));

vi.mock("../../identity.js", () => ({
  getPrimaryIdentityId: () => null,
  getSelfIdentity: () => ({ e164: "+15550001111" }),
  getSenderIdentity: () => ({ name: "Alice", e164: "+15550002222" }),
}));

vi.mock("../../reconnect.js", () => ({ newConnectionId: () => "test-conn-id" }));
vi.mock("../../session.js", () => ({ formatError: (e: unknown) => String(e) }));
vi.mock("../deliver-reply.js", () => ({ deliverWebReply: async () => {} }));
vi.mock("../loggers.js", () => ({
  whatsappInboundLog: { info: () => {}, debug: () => {} },
}));
vi.mock("./ack-reaction.js", () => ({ maybeSendAckReaction: async () => {} }));
vi.mock("./inbound-context.js", () => ({
  resolveVisibleWhatsAppGroupHistory: () => [],
  resolveVisibleWhatsAppReplyContext: () => null,
}));
vi.mock("./last-route.js", () => ({
  trackBackgroundTask: () => {},
  updateLastRouteInBackground: () => {},
}));
vi.mock("./message-line.js", () => ({ buildInboundLine: () => "hi" }));
vi.mock("./runtime-api.js", () => ({
  buildHistoryContextFromEntries: () => "hi",
  createChannelReplyPipeline: () => ({ onModelSelected: () => {}, responsePrefix: undefined }),
  formatInboundEnvelope: () => "hi",
  logVerbose: () => {},
  normalizeE164: (v: string) => v,
  recordSessionMetaFromInbound: async () => {},
  resolveChannelContextVisibilityMode: () => "off",
  resolveInboundSessionEnvelopeContext: () => ({
    storePath: "/tmp",
    envelopeOptions: {},
    previousTimestamp: undefined,
  }),
  resolvePinnedMainDmOwnerFromAllowlist: () => null,
  shouldComputeCommandAuthorized: () => false,
  shouldLogVerbose: () => false,
}));

import { processMessage } from "./process-message.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccount(groups: Record<string, { systemPrompt?: string }> = {}): {
  accountId: string;
  authDir: string;
  groups: Record<string, { systemPrompt?: string }>;
} {
  return { accountId: "default", authDir: "/tmp/wa-test-auth", groups };
}

function makePolicy(account: ReturnType<typeof makeAccount>) {
  return {
    account,
    dmPolicy: "pairing",
    groupPolicy: "allowlist",
    configuredAllowFrom: [],
    dmAllowFrom: [],
    groupAllowFrom: [],
    isSelfChat: false,
    providerMissingFallbackApplied: false,
    shouldReadStorePairingApprovals: true,
    isSamePhone: () => false,
    isDmSenderAllowed: () => false,
    isGroupSenderAllowed: () => false,
    resolveConversationGroupPolicy: () => "allowlist",
    resolveConversationRequireMention: () => false,
  };
}

const GROUP_JID = "123@g.us";

const baseMsg = {
  id: "msg1",
  from: GROUP_JID,
  to: "+15550001111",
  conversationId: GROUP_JID,
  accountId: "default",
  chatId: GROUP_JID,
  chatType: "group" as const,
  body: "hi",
  sendComposing: async () => {},
  reply: async () => {},
  sendMedia: async () => {},
};

const baseRoute = {
  agentId: "main",
  channel: "whatsapp",
  accountId: "default",
  sessionKey: "agent:main:whatsapp:group:123@g.us",
  mainSessionKey: "agent:main:whatsapp:group:123@g.us",
  lastRoutePolicy: "main",
  matchedBy: "default",
};

function callProcessMessage() {
  return processMessage({
    cfg: {} as never,
    msg: baseMsg as never,
    route: baseRoute as never,
    groupHistoryKey: "whatsapp:default:group:123@g.us",
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    connectionId: "conn-1",
    verbose: false,
    maxMediaBytes: 1024,
    replyResolver: (async () => undefined) as never,
    replyLogger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    backgroundTasks: new Set(),
    rememberSentText: () => {},
    echoHas: () => false,
    echoForget: () => {},
    buildCombinedEchoKey: ({ sessionKey }) => sessionKey,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processMessage group system prompt wiring", () => {
  beforeEach(() => {
    buildContextMock.mockReset();
    resolvePolicyMock.mockReset();
    buildContextMock.mockImplementation(
      (params: { groupSystemPrompt?: string; combinedBody?: string }) => ({
        GroupSystemPrompt: params.groupSystemPrompt,
        Body: params.combinedBody ?? "",
      }),
    );
  });

  it("resolves group systemPrompt from account config and passes it into buildWhatsAppInboundContext", async () => {
    resolvePolicyMock.mockReturnValue(
      makePolicy(makeAccount({ [GROUP_JID]: { systemPrompt: "from config" } })),
    );

    await callProcessMessage();

    expect(buildContextMock.mock.calls[0][0].groupSystemPrompt).toBe("from config");
  });
});
