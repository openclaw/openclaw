import type { ConfiguredBindingRouteResult } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const processMessageMock = vi.hoisted(() => vi.fn());
const resolveConfiguredBindingRouteMock = vi.hoisted(() => vi.fn());
const ensureConfiguredBindingRouteReadyMock = vi.hoisted(() => vi.fn());
const resolveAgentRouteMock = vi.hoisted(() => vi.fn());
const resolveGroupActivationForMock = vi.hoisted(() => vi.fn());
const updateLastRouteInBackgroundMock = vi.hoisted(() => vi.fn());
const transcribeFirstAudioMock = vi.hoisted(() => vi.fn());
const maybeSendAckReactionMock = vi.hoisted(() => vi.fn());
const createStatusReactionControllerMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  resolveConfiguredBindingRoute: (...args: unknown[]) => resolveConfiguredBindingRouteMock(...args),
  ensureConfiguredBindingRouteReady: (...args: unknown[]) =>
    ensureConfiguredBindingRouteReadyMock(...args),
}));

vi.mock("./audio-preflight.runtime.js", () => ({
  transcribeFirstAudio: (...args: unknown[]) => transcribeFirstAudioMock(...args),
}));

vi.mock("./ack-reaction.js", () => ({
  maybeSendAckReaction: (...args: unknown[]) => maybeSendAckReactionMock(...args),
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

vi.mock("../../identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../identity.js")>()),
  getPrimaryIdentityId: () => "+15551234567",
  getSenderIdentity: () => ({ e164: "+15551234567", name: "Alice" }),
}));

vi.mock("./group-activation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./group-activation.js")>()),
  resolveGroupActivationFor: (...args: unknown[]) => resolveGroupActivationForMock(...args),
}));

vi.mock("./last-route.js", () => ({
  updateLastRouteInBackground: (...args: unknown[]) => updateLastRouteInBackgroundMock(...args),
}));

vi.mock("./process-message.js", () => ({
  processMessage: (...args: unknown[]) => processMessageMock(...args),
}));

vi.mock("./status-reaction.js", () => ({
  createWhatsAppStatusReactionController: (...args: unknown[]) =>
    createStatusReactionControllerMock(...args),
}));

import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import { createMonitorContext } from "./monitor.test-support.js";
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
const directConversationId = "+15551234567";
const groupConversationId = "120363001234567890@g.us";

function configuredBinding(conversationId: string, kind: "direct" | "group") {
  const conversation = { channel: "whatsapp", accountId: "work", conversationId };
  const record = {
    bindingId: `config:acp:whatsapp:work:${conversationId}`,
    targetSessionKey: boundSessionKey,
    targetKind: "session",
    conversation,
    status: "active",
    boundAt: 0,
    metadata: {
      source: "config",
      mode: "oneshot",
      agentId: "sandboxed-agent",
    },
  } as const;
  const statefulTarget = {
    kind: "stateful",
    driverId: "acp",
    sessionKey: boundSessionKey,
    agentId: "sandboxed-agent",
  } as const;

  return {
    conversation,
    compiledBinding: {
      channel: "whatsapp",
      accountPattern: "work",
      binding: {
        type: "acp",
        agentId: "sandboxed-agent",
        match: {
          channel: "whatsapp",
          accountId: "work",
          peer: { kind, id: conversationId },
        },
      },
      bindingConversationId: conversationId,
      target: { conversationId },
      agentId: "sandboxed-agent",
      provider: {
        compileConfiguredBinding: () => ({ conversationId }),
        matchInboundConversation: () => ({ conversationId }),
      },
      targetFactory: {
        driverId: "acp",
        materialize: () => ({
          record,
          statefulTarget,
        }),
      },
    },
    match: { conversationId },
    record,
    statefulTarget,
  } as const;
}
const configuredBindingResolution = configuredBinding(directConversationId, "direct");
const configuredGroupBindingResolution = configuredBinding(groupConversationId, "group");

type ConfiguredBindingResolution = NonNullable<ConfiguredBindingRouteResult["bindingResolution"]>;

function resolvedConfiguredRoute(
  bindingResolution: ConfiguredBindingResolution = configuredBindingResolution,
) {
  return ({ route }: { route: typeof baseRoute }) => ({
    bindingResolution,
    boundSessionKey,
    boundAgentId: "sandboxed-agent",
    route: {
      ...route,
      agentId: "sandboxed-agent",
      sessionKey: boundSessionKey,
      matchedBy: "binding.channel",
    },
  });
}

function createCfg(kind: "direct" | "group" = "direct"): Record<string, unknown> {
  const resolution =
    kind === "direct" ? configuredBindingResolution : configuredGroupBindingResolution;
  return { bindings: [resolution.compiledBinding.binding] };
}

function createGroupCfg(): Record<string, unknown> {
  return {
    messages: { groupChat: { mentionPatterns: ["\\bopenclaw\\b"] } },
    channels: { whatsapp: { groupPolicy: "open", accounts: { work: {} } } },
    broadcast: { "120363001234567890@g.us": ["main", "backup"] },
    agents: { entries: { main: {}, backup: {}, "sandboxed-agent": {} } },
    ...createCfg("group"),
  };
}

function createHandler(group = false) {
  if (group) {
    resolveConfiguredBindingRouteMock.mockImplementationOnce(
      resolvedConfiguredRoute(configuredGroupBindingResolution),
    );
  }
  const cfg = group ? createGroupCfg() : createCfg();
  const context = createMonitorContext();
  return {
    groupHistories: context.groupHistories,
    handler: createWebOnMessageHandler({
      ...context,
      cfg: cfg as never,
      groupHistoryLimit: 20,
    }),
  };
}

function createMessage({
  group = false,
  audio = false,
  body,
  id,
  conversationId = group ? groupConversationId : "15551234567@s.whatsapp.net",
}: {
  group?: boolean;
  audio?: boolean;
  body?: string;
  id?: string;
  conversationId?: string;
} = {}) {
  return createTestWebInboundMessage({
    ...(id ? { event: { id } } : {}),
    ...(audio
      ? {
          payload: {
            body: "",
            media: { type: "audio/ogg; codecs=opus", path: "/tmp/voice.ogg", kind: "audio" },
          },
        }
      : body === undefined
        ? {}
        : { payload: { body } }),
    admission: {
      accountId: "work",
      conversation: { kind: group ? "group" : "direct", id: conversationId },
      sender: { id: conversationId },
      ...(group ? { senderAccess: { reasonCode: "group_policy_allowed" } } : {}),
    },
    platform: {
      chatJid: conversationId,
      recipientJid: "15559876543@s.whatsapp.net",
    },
  });
}

describe("createWebOnMessageHandler configured ACP bindings", () => {
  beforeEach(() => {
    processMessageMock.mockReset().mockResolvedValue(true);
    resolveGroupActivationForMock.mockReset().mockResolvedValue("always");
    updateLastRouteInBackgroundMock.mockReset();
    transcribeFirstAudioMock.mockReset().mockResolvedValue("openclaw please handle this");
    maybeSendAckReactionMock.mockReset().mockResolvedValue(null);
    createStatusReactionControllerMock.mockReset().mockResolvedValue(null);
    resolveAgentRouteMock.mockReset().mockReturnValue(baseRoute);
    ensureConfiguredBindingRouteReadyMock.mockReset().mockResolvedValue({ ok: true });
    resolveConfiguredBindingRouteMock.mockReset().mockImplementation(resolvedConfiguredRoute());
  });

  it("dispatches two same-content messages with distinct native ids in order", async () => {
    const sentConversation = "15550001111@s.whatsapp.net";
    resolveConfiguredBindingRouteMock.mockImplementation(({ route }) => ({
      bindingResolution: null,
      route,
    }));
    const { handler } = createHandler();

    const messageForId = (id: string) =>
      createMessage({ conversationId: sentConversation, id, body: "Done." });

    await handler(messageForId("in-2"));
    await handler(messageForId("in-3"));

    expect(processMessageMock.mock.calls.map(([params]) => params.msg.event.id)).toEqual([
      "in-2",
      "in-3",
    ]);
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
    expect(processMessageMock.mock.calls[0]?.[0]).toMatchObject({
      route: { sessionKey: baseRoute.sessionKey, matchedBy: baseRoute.matchedBy },
    });
  });

  it("waits for group admission before ensuring a configured ACP binding target", async () => {
    resolveGroupActivationForMock.mockResolvedValueOnce("mention");
    const { handler, groupHistories } = createHandler(true);

    await handler(createMessage({ group: true, body: "ambient group message" }));

    expect(resolveGroupActivationForMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "sandboxed-agent",
        sessionKey: boundSessionKey,
      }),
    );
    expect(ensureConfiguredBindingRouteReadyMock).not.toHaveBeenCalled();
    expect(updateLastRouteInBackgroundMock).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
    expect(groupHistories.get("group-key")).toEqual([
      expect.objectContaining({ body: "ambient group message", sender: "Alice (+15551234567)" }),
    ]);
  });

  it("removes preflight ack when configured ACP readiness fails after group audio mention gating", async () => {
    const ackReaction = {
      ackReactionPromise: Promise.resolve(true),
      ackReactionValue: "👀",
      remove: vi.fn(async () => undefined),
    };
    resolveGroupActivationForMock.mockResolvedValue("mention");
    maybeSendAckReactionMock.mockResolvedValueOnce(ackReaction);
    ensureConfiguredBindingRouteReadyMock.mockResolvedValueOnce({
      ok: false,
      error: "acpx backend unavailable",
    });
    const { handler } = createHandler(true);

    await handler(createMessage({ group: true, audio: true }));

    expect(transcribeFirstAudioMock).toHaveBeenCalledTimes(1);
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);
    expect(ackReaction.remove).toHaveBeenCalledTimes(1);
    expect(processMessageMock).not.toHaveBeenCalled();
  });

  it("records configured ACP group routes after admission and readiness", async () => {
    const { handler } = createHandler(true);

    await handler(createMessage({ group: true }));

    expect(updateLastRouteInBackgroundMock).toHaveBeenCalledTimes(1);
    expect(updateLastRouteInBackgroundMock).toHaveBeenCalledWith(
      expect.objectContaining({
        storeAgentId: "sandboxed-agent",
        sessionKey: boundSessionKey,
        channel: "whatsapp",
        to: "120363001234567890@g.us",
        accountId: "work",
      }),
    );
    expect(ensureConfiguredBindingRouteReadyMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateLastRouteInBackgroundMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(processMessageMock).toHaveBeenCalledTimes(1);
  });
});
