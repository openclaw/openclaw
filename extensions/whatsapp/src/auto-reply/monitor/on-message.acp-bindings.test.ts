// Whatsapp tests cover inbound configured ACP binding route materialization.
import { beforeEach, describe, expect, it, vi } from "vitest";

const processMessageMock = vi.fn();
const maybeBroadcastMessageMock = vi.fn();
const resolveConfiguredBindingRouteMock = vi.fn();
const ensureConfiguredBindingRouteReadyMock = vi.fn();
const resolveAgentRouteMock = vi.fn();

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  resolveConfiguredBindingRoute: (...args: unknown[]) => resolveConfiguredBindingRouteMock(...args),
  ensureConfiguredBindingRouteReady: (...args: unknown[]) =>
    ensureConfiguredBindingRouteReadyMock(...args),
}));

vi.mock("openclaw/plugin-sdk/routing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/routing")>();
  return {
    ...actual,
    buildGroupHistoryKey: () => "group-key",
    resolveAgentRoute: (...args: unknown[]) => resolveAgentRouteMock(...args),
  };
});

vi.mock("../../accounts.js", () => ({
  resolveWhatsAppAccount: () => ({
    accountId: "work",
    authDir: "/tmp/whatsapp-auth",
    mentionPatterns: [],
    selfChatMode: false,
  }),
}));

vi.mock("../../group-session-key.js", () => ({
  resolveWhatsAppGroupSessionRoute: (route: unknown) => route,
}));

vi.mock("../../identity.js", () => ({
  getPrimaryIdentityId: () => "+15551234567",
  getSenderIdentity: () => ({ e164: "+15551234567", name: "Alice" }),
}));

vi.mock("./broadcast.js", () => ({
  maybeBroadcastMessage: (...args: unknown[]) => maybeBroadcastMessageMock(...args),
}));

vi.mock("./last-route.js", () => ({
  updateLastRouteInBackground: () => {},
}));

vi.mock("./process-message.js", () => ({
  processMessage: (...args: unknown[]) => processMessageMock(...args),
}));

import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import { createWebOnMessageHandler } from "./on-message.js";

const baseRoute = {
  agentId: "sandboxed-agent",
  accountId: "work",
  channel: "whatsapp",
  sessionKey: "agent:sandboxed-agent:whatsapp:direct:+15551234567",
  mainSessionKey: "agent:sandboxed-agent:main",
  matchedBy: "binding.agent",
  lastRoutePolicy: "bound",
};

const boundSessionKey = "agent:sandboxed-agent:acp:binding:whatsapp:work:abc123";

const configuredBindingRecord = {
  bindingId: "config:acp:whatsapp:work:+15551234567",
  targetSessionKey: boundSessionKey,
  targetKind: "session",
  conversation: {
    channel: "whatsapp",
    accountId: "work",
    conversationId: "+15551234567",
  },
  status: "active",
  boundAt: 0,
  metadata: {
    source: "config",
    mode: "oneshot",
    agentId: "sandboxed-agent",
  },
} as const;

const configuredStatefulTarget = {
  kind: "stateful",
  driverId: "acp",
  sessionKey: boundSessionKey,
  agentId: "sandboxed-agent",
} as const;

const configuredBindingResolution = {
  conversation: {
    channel: "whatsapp",
    accountId: "work",
    conversationId: "+15551234567",
  },
  compiledBinding: {
    channel: "whatsapp",
    accountPattern: "work",
    binding: {
      type: "acp",
      agentId: "sandboxed-agent",
      match: {
        channel: "whatsapp",
        accountId: "work",
        peer: { kind: "direct", id: "+15551234567" },
      },
    },
    bindingConversationId: "+15551234567",
    target: { conversationId: "+15551234567" },
    agentId: "sandboxed-agent",
    provider: {
      compileConfiguredBinding: () => ({ conversationId: "+15551234567" }),
      matchInboundConversation: () => ({ conversationId: "+15551234567" }),
    },
    targetFactory: {
      driverId: "acp",
      materialize: () => ({
        record: configuredBindingRecord,
        statefulTarget: configuredStatefulTarget,
      }),
    },
  },
  match: { conversationId: "+15551234567" },
  record: configuredBindingRecord,
  statefulTarget: configuredStatefulTarget,
} as const;

function createHandler(warn = vi.fn()) {
  return {
    warn,
    handler: createWebOnMessageHandler({
      cfg: {
        bindings: [
          {
            type: "acp",
            agentId: "sandboxed-agent",
            match: {
              channel: "whatsapp",
              accountId: "work",
              peer: { kind: "direct", id: "+15551234567" },
            },
          },
        ],
      } as never,
      verbose: false,
      connectionId: "conn-1",
      maxMediaBytes: 1024 * 1024,
      groupHistoryLimit: 20,
      groupHistories: new Map(),
      groupMemberNames: new Map(),
      echoTracker: {
        has: () => false,
        forget: () => {},
        rememberText: () => {},
        buildCombinedKey: ({ combinedBody }: { combinedBody: string }) => combinedBody,
      },
      backgroundTasks: new Set(),
      replyResolver: vi.fn() as never,
      replyLogger: {
        info: () => {},
        warn,
        debug: () => {},
        error: () => {},
      } as never,
      baseMentionConfig: {} as never,
      account: { authDir: "/tmp/whatsapp-auth", accountId: "work" },
    }),
  };
}

function createMessage() {
  return createTestWebInboundMessage({
    accountId: "work",
    from: "15551234567@s.whatsapp.net",
    conversationId: "15551234567@s.whatsapp.net",
    platform: {
      chatJid: "15551234567@s.whatsapp.net",
      recipientJid: "15559876543@s.whatsapp.net",
    },
  });
}

describe("createWebOnMessageHandler configured ACP bindings", () => {
  beforeEach(() => {
    processMessageMock.mockReset();
    processMessageMock.mockResolvedValue(true);
    maybeBroadcastMessageMock.mockReset();
    maybeBroadcastMessageMock.mockResolvedValue(false);
    resolveAgentRouteMock.mockReset();
    resolveAgentRouteMock.mockReturnValue(baseRoute);
    ensureConfiguredBindingRouteReadyMock.mockReset();
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({ ok: true });
    resolveConfiguredBindingRouteMock.mockReset();
    resolveConfiguredBindingRouteMock.mockImplementation(({ route }) => ({
      bindingResolution: configuredBindingResolution,
      boundSessionKey,
      boundAgentId: "sandboxed-agent",
      route: {
        ...route,
        agentId: "sandboxed-agent",
        sessionKey: boundSessionKey,
        matchedBy: "binding.channel",
      },
    }));
  });

  it("rewrites matching WhatsApp inbound turns to the configured ACP session key", async () => {
    const { handler } = createHandler();

    await handler(createMessage());

    expect(resolveConfiguredBindingRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "work",
        conversationId: "+15551234567",
        route: baseRoute,
      }),
    );
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      bindingResolution: configuredBindingResolution,
    });
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    expect(processMessageMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        route: expect.objectContaining({
          sessionKey: boundSessionKey,
          matchedBy: "binding.channel",
        }),
      }),
    );
  });

  it("drops the inbound turn instead of falling back when ACP binding readiness fails", async () => {
    const { handler, warn } = createHandler();
    ensureConfiguredBindingRouteReadyMock.mockResolvedValueOnce({
      ok: false,
      error: "acpx backend unavailable",
    });

    await handler(createMessage());

    expect(processMessageMock).not.toHaveBeenCalled();
    expect(maybeBroadcastMessageMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "whatsapp: configured ACP binding unavailable for conversation +15551234567: acpx backend unavailable",
    );
  });

  it("keeps the ordinary WhatsApp route when no configured ACP binding matches", async () => {
    const { handler } = createHandler();
    resolveConfiguredBindingRouteMock.mockImplementationOnce(({ route }) => ({
      bindingResolution: null,
      route,
    }));

    await handler(createMessage());

    expect(ensureConfiguredBindingRouteReadyMock).not.toHaveBeenCalled();
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    expect(processMessageMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        route: expect.objectContaining({
          sessionKey: baseRoute.sessionKey,
          matchedBy: baseRoute.matchedBy,
        }),
      }),
    );
  });
});
