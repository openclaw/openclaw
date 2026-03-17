import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerTelegramNativeCommands
} from "./bot-native-commands.js";
const dispatchReplyResult = {
  queuedFinal: false,
  counts: {}
};
const persistentBindingMocks = vi.hoisted(() => ({
  resolveConfiguredAcpBindingRecord: vi.fn(() => null),
  ensureConfiguredAcpBindingSession: vi.fn(async () => ({
    ok: true,
    sessionKey: "agent:codex:acp:binding:telegram:default:seed"
  }))
}));
const sessionMocks = vi.hoisted(() => ({
  recordSessionMetaFromInbound: vi.fn(),
  resolveStorePath: vi.fn()
}));
const replyMocks = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(
    async () => dispatchReplyResult
  )
}));
const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn(async () => ({ delivered: true }))
}));
const sessionBindingMocks = vi.hoisted(() => ({
  resolveByConversation: vi.fn(() => null),
  touch: vi.fn()
}));
vi.mock("../../../src/acp/persistent-bindings.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveConfiguredAcpBindingRecord: persistentBindingMocks.resolveConfiguredAcpBindingRecord,
    ensureConfiguredAcpBindingSession: persistentBindingMocks.ensureConfiguredAcpBindingSession
  };
});
vi.mock("../../../src/config/sessions.js", () => ({
  recordSessionMetaFromInbound: sessionMocks.recordSessionMetaFromInbound,
  resolveStorePath: sessionMocks.resolveStorePath
}));
vi.mock("../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn(async () => [])
}));
vi.mock("../../../src/auto-reply/reply/inbound-context.js", () => ({
  finalizeInboundContext: vi.fn((ctx) => ctx)
}));
vi.mock("../../../src/auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher: replyMocks.dispatchReplyWithBufferedBlockDispatcher
}));
vi.mock("../../../src/channels/reply-prefix.js", () => ({
  createReplyPrefixOptions: vi.fn(() => ({ onModelSelected: () => {
  } }))
}));
vi.mock("../../../src/infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    bind: vi.fn(),
    getCapabilities: vi.fn(),
    listBySession: vi.fn(),
    resolveByConversation: (ref) => sessionBindingMocks.resolveByConversation(ref),
    touch: (bindingId, at) => sessionBindingMocks.touch(bindingId, at),
    unbind: vi.fn()
  })
}));
vi.mock("../../../src/auto-reply/skill-commands.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, listSkillCommandsForAgents: vi.fn(() => []) };
});
vi.mock("../../../src/plugins/commands.js", () => ({
  getPluginCommandSpecs: vi.fn(() => []),
  matchPluginCommand: vi.fn(() => null),
  executePluginCommand: vi.fn(async () => ({ text: "ok" }))
}));
vi.mock("./bot/delivery.js", () => ({
  deliverReplies: deliveryMocks.deliverReplies
}));
function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
function createNativeCommandTestParams(params = {}) {
  const log = vi.fn();
  return {
    bot: params.bot ?? {
      api: {
        setMyCommands: vi.fn().mockResolvedValue(void 0),
        sendMessage: vi.fn().mockResolvedValue(void 0)
      },
      command: vi.fn()
    },
    cfg: params.cfg ?? {},
    runtime: params.runtime ?? { log },
    accountId: params.accountId ?? "default",
    telegramCfg: params.telegramCfg ?? {},
    allowFrom: params.allowFrom ?? [],
    groupAllowFrom: params.groupAllowFrom ?? [],
    replyToMode: params.replyToMode ?? "off",
    textLimit: params.textLimit ?? 4e3,
    useAccessGroups: params.useAccessGroups ?? false,
    nativeEnabled: params.nativeEnabled ?? true,
    nativeSkillsEnabled: params.nativeSkillsEnabled ?? false,
    nativeDisabledExplicit: params.nativeDisabledExplicit ?? false,
    resolveGroupPolicy: params.resolveGroupPolicy ?? (() => ({
      allowlistEnabled: false,
      allowed: true
    })),
    resolveTelegramGroupConfig: params.resolveTelegramGroupConfig ?? (() => ({ groupConfig: void 0, topicConfig: void 0 })),
    shouldSkipUpdate: params.shouldSkipUpdate ?? (() => false),
    opts: params.opts ?? { token: "token" }
  };
}
function buildStatusCommandContext() {
  return {
    match: "",
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1e3),
      chat: { id: 100, type: "private" },
      from: { id: 200, username: "bob" }
    }
  };
}
function buildStatusTopicCommandContext() {
  return {
    match: "",
    message: {
      message_id: 2,
      date: Math.floor(Date.now() / 1e3),
      chat: {
        id: -1001234567890,
        type: "supergroup",
        title: "OpenClaw",
        is_forum: true
      },
      message_thread_id: 42,
      from: { id: 200, username: "bob" }
    }
  };
}
function registerAndResolveStatusHandler(params) {
  const { cfg, allowFrom, groupAllowFrom, resolveTelegramGroupConfig } = params;
  return registerAndResolveCommandHandlerBase({
    commandName: "status",
    cfg,
    allowFrom: allowFrom ?? ["*"],
    groupAllowFrom: groupAllowFrom ?? [],
    useAccessGroups: true,
    resolveTelegramGroupConfig
  });
}
function registerAndResolveCommandHandlerBase(params) {
  const {
    commandName,
    cfg,
    allowFrom,
    groupAllowFrom,
    useAccessGroups,
    resolveTelegramGroupConfig
  } = params;
  const commandHandlers = /* @__PURE__ */ new Map();
  const sendMessage = vi.fn().mockResolvedValue(void 0);
  registerTelegramNativeCommands({
    ...createNativeCommandTestParams({
      bot: {
        api: {
          setMyCommands: vi.fn().mockResolvedValue(void 0),
          sendMessage
        },
        command: vi.fn((name, cb) => {
          commandHandlers.set(name, cb);
        })
      },
      cfg,
      allowFrom,
      groupAllowFrom,
      useAccessGroups,
      resolveTelegramGroupConfig
    })
  });
  const handler = commandHandlers.get(commandName);
  expect(handler).toBeTruthy();
  return { handler, sendMessage };
}
function registerAndResolveCommandHandler(params) {
  const {
    commandName,
    cfg,
    allowFrom,
    groupAllowFrom,
    useAccessGroups,
    resolveTelegramGroupConfig
  } = params;
  return registerAndResolveCommandHandlerBase({
    commandName,
    cfg,
    allowFrom: allowFrom ?? [],
    groupAllowFrom: groupAllowFrom ?? [],
    useAccessGroups: useAccessGroups ?? true,
    resolveTelegramGroupConfig
  });
}
function createConfiguredAcpTopicBinding(boundSessionKey) {
  return {
    spec: {
      channel: "telegram",
      accountId: "default",
      conversationId: "-1001234567890:topic:42",
      parentConversationId: "-1001234567890",
      agentId: "codex",
      mode: "persistent"
    },
    record: {
      bindingId: "config:acp:telegram:default:-1001234567890:topic:42",
      targetSessionKey: boundSessionKey,
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1001234567890:topic:42",
        parentConversationId: "-1001234567890"
      },
      status: "active",
      boundAt: 0
    }
  };
}
function expectUnauthorizedNewCommandBlocked(sendMessage) {
  expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  expect(persistentBindingMocks.resolveConfiguredAcpBindingRecord).not.toHaveBeenCalled();
  expect(persistentBindingMocks.ensureConfiguredAcpBindingSession).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledWith(
    -1001234567890,
    "You are not authorized to use this command.",
    expect.objectContaining({ message_thread_id: 42 })
  );
}
describe("registerTelegramNativeCommands \u2014 session metadata", () => {
  beforeEach(() => {
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockClear();
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReturnValue(null);
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockClear();
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockResolvedValue({
      ok: true,
      sessionKey: "agent:codex:acp:binding:telegram:default:seed"
    });
    sessionMocks.recordSessionMetaFromInbound.mockClear().mockResolvedValue(void 0);
    sessionMocks.resolveStorePath.mockClear().mockReturnValue("/tmp/openclaw-sessions.json");
    replyMocks.dispatchReplyWithBufferedBlockDispatcher.mockClear().mockResolvedValue(dispatchReplyResult);
    sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
    sessionBindingMocks.touch.mockReset();
    deliveryMocks.deliverReplies.mockClear().mockResolvedValue({ delivered: true });
  });
  it("calls recordSessionMetaFromInbound after a native slash command", async () => {
    const cfg = {};
    const { handler } = registerAndResolveStatusHandler({ cfg });
    await handler(buildStatusCommandContext());
    expect(sessionMocks.recordSessionMetaFromInbound).toHaveBeenCalledTimes(1);
    const call = sessionMocks.recordSessionMetaFromInbound.mock.calls[0]?.[0];
    expect(call?.ctx?.OriginatingChannel).toBe("telegram");
    expect(call?.ctx?.Provider).toBe("telegram");
    expect(call?.sessionKey).toBe("agent:main:telegram:slash:200");
  });
  it("awaits session metadata persistence before dispatch", async () => {
    const deferred = createDeferred();
    sessionMocks.recordSessionMetaFromInbound.mockReturnValue(deferred.promise);
    const cfg = {};
    const { handler } = registerAndResolveStatusHandler({ cfg });
    const runPromise = handler(buildStatusCommandContext());
    await vi.waitFor(() => {
      expect(sessionMocks.recordSessionMetaFromInbound).toHaveBeenCalledTimes(1);
    });
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    deferred.resolve();
    await runPromise;
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });
  it("does not inject approval buttons for native command replies once the monitor owns approvals", async () => {
    replyMocks.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver(
          {
            text: "Mode: foreground\nRun: /approve 7f423fdc allow-once (or allow-always / deny)."
          },
          { kind: "final" }
        );
        return dispatchReplyResult;
      }
    );
    const { handler } = registerAndResolveStatusHandler({
      cfg: {
        channels: {
          telegram: {
            execApprovals: {
              enabled: true,
              approvers: ["12345"],
              target: "dm"
            }
          }
        }
      }
    });
    await handler(buildStatusCommandContext());
    const deliveredCall = deliveryMocks.deliverReplies.mock.calls[0]?.[0];
    const deliveredPayload = deliveredCall?.replies?.[0];
    expect(deliveredPayload).toBeTruthy();
    expect(deliveredPayload?.["text"]).toContain("/approve 7f423fdc allow-once");
    expect(deliveredPayload?.["channelData"]).toBeUndefined();
  });
  it("suppresses local structured exec approval replies for native commands", async () => {
    replyMocks.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver(
          {
            text: "Approval required.\n\n```txt\n/approve 7f423fdc allow-once\n```",
            channelData: {
              execApproval: {
                approvalId: "7f423fdc-1111-2222-3333-444444444444",
                approvalSlug: "7f423fdc",
                allowedDecisions: ["allow-once", "allow-always", "deny"]
              }
            }
          },
          { kind: "tool" }
        );
        return dispatchReplyResult;
      }
    );
    const { handler } = registerAndResolveStatusHandler({
      cfg: {
        channels: {
          telegram: {
            execApprovals: {
              enabled: true,
              approvers: ["12345"],
              target: "dm"
            }
          }
        }
      }
    });
    await handler(buildStatusCommandContext());
    expect(deliveryMocks.deliverReplies).not.toHaveBeenCalled();
  });
  it("routes Telegram native commands through configured ACP topic bindings", async () => {
    const boundSessionKey = "agent:codex:acp:binding:telegram:default:feedface";
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReturnValue(
      createConfiguredAcpTopicBinding(boundSessionKey)
    );
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockResolvedValue({
      ok: true,
      sessionKey: boundSessionKey
    });
    const { handler } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: ["200"],
      groupAllowFrom: ["200"]
    });
    await handler(buildStatusTopicCommandContext());
    expect(persistentBindingMocks.resolveConfiguredAcpBindingRecord).toHaveBeenCalledTimes(1);
    expect(persistentBindingMocks.ensureConfiguredAcpBindingSession).toHaveBeenCalledTimes(1);
    const dispatchCall = replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];
    expect(dispatchCall?.ctx?.CommandTargetSessionKey).toBe(boundSessionKey);
    const sessionMetaCall = sessionMocks.recordSessionMetaFromInbound.mock.calls[0]?.[0];
    expect(sessionMetaCall?.sessionKey).toBe("agent:codex:telegram:slash:200");
  });
  it("routes Telegram native commands through topic-specific agent sessions", async () => {
    const { handler } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: ["200"],
      groupAllowFrom: ["200"],
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: { agentId: "zu" }
      })
    });
    await handler(buildStatusTopicCommandContext());
    const dispatchCall = replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];
    expect(dispatchCall?.ctx?.CommandTargetSessionKey).toBe(
      "agent:zu:telegram:group:-1001234567890:topic:42"
    );
  });
  it("routes Telegram native commands through bound topic sessions", async () => {
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "default:-1001234567890:topic:42",
      targetSessionKey: "agent:codex-acp:session-1"
    });
    const { handler } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: ["200"],
      groupAllowFrom: ["200"]
    });
    await handler(buildStatusTopicCommandContext());
    expect(sessionBindingMocks.resolveByConversation).toHaveBeenCalledWith({
      channel: "telegram",
      accountId: "default",
      conversationId: "-1001234567890:topic:42"
    });
    const dispatchCall = replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0];
    expect(dispatchCall?.ctx?.CommandTargetSessionKey).toBe("agent:codex-acp:session-1");
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith(
      "default:-1001234567890:topic:42",
      void 0
    );
  });
  it("aborts native command dispatch when configured ACP topic binding cannot initialize", async () => {
    const boundSessionKey = "agent:codex:acp:binding:telegram:default:feedface";
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReturnValue(
      createConfiguredAcpTopicBinding(boundSessionKey)
    );
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockResolvedValue({
      ok: false,
      sessionKey: boundSessionKey,
      error: "gateway unavailable"
    });
    const { handler, sendMessage } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: ["200"],
      groupAllowFrom: ["200"]
    });
    await handler(buildStatusTopicCommandContext());
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      -1001234567890,
      "Configured ACP binding is unavailable right now. Please try again.",
      expect.objectContaining({ message_thread_id: 42 })
    );
  });
  it("keeps /new blocked in ACP-bound Telegram topics when sender is unauthorized", async () => {
    const boundSessionKey = "agent:codex:acp:binding:telegram:default:feedface";
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReturnValue(
      createConfiguredAcpTopicBinding(boundSessionKey)
    );
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockResolvedValue({
      ok: true,
      sessionKey: boundSessionKey
    });
    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "new",
      cfg: {},
      allowFrom: [],
      groupAllowFrom: [],
      useAccessGroups: true
    });
    await handler(buildStatusTopicCommandContext());
    expectUnauthorizedNewCommandBlocked(sendMessage);
  });
  it("keeps /new blocked for unbound Telegram topics when sender is unauthorized", async () => {
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReturnValue(null);
    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "new",
      cfg: {},
      allowFrom: [],
      groupAllowFrom: [],
      useAccessGroups: true
    });
    await handler(buildStatusTopicCommandContext());
    expectUnauthorizedNewCommandBlocked(sendMessage);
  });
});
