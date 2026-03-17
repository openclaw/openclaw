import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import {
  createDeferred,
  createNativeCommandTestParams,
  createTelegramPrivateCommandContext,
  createTelegramTopicCommandContext,
  type NativeCommandTestParams,
} from "./bot-native-commands.fixture-test-support.js";
import {
  registerTelegramNativeCommands,
  type RegisterTelegramHandlerParams,
} from "./bot-native-commands.js";

// All mocks scoped to this file only — does not affect bot-native-commands.test.ts

type ResolveConfiguredAcpBindingRecordFn =
  typeof import("../../../src/acp/persistent-bindings.js").resolveConfiguredAcpBindingRecord;
type EnsureConfiguredAcpBindingSessionFn =
  typeof import("../../../src/acp/persistent-bindings.js").ensureConfiguredAcpBindingSession;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("../../../src/auto-reply/reply/provider-dispatcher.js").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyWithBufferedBlockDispatcherParams =
  Parameters<DispatchReplyWithBufferedBlockDispatcherFn>[0];
type DispatchReplyWithBufferedBlockDispatcherResult = Awaited<
  ReturnType<DispatchReplyWithBufferedBlockDispatcherFn>
>;
type DeliverRepliesFn = typeof import("./bot/delivery.js").deliverReplies;
type DeliverRepliesParams = Parameters<DeliverRepliesFn>[0];

const dispatchReplyResult: DispatchReplyWithBufferedBlockDispatcherResult = {
  queuedFinal: false,
  counts: {} as DispatchReplyWithBufferedBlockDispatcherResult["counts"],
};

const persistentBindingMocks = vi.hoisted(() => ({
  resolveConfiguredAcpBindingRecord: vi.fn<ResolveConfiguredAcpBindingRecordFn>(() => null),
  ensureConfiguredAcpBindingSession: vi.fn<EnsureConfiguredAcpBindingSessionFn>(async () => ({
    ok: true,
    sessionKey: "agent:codex:acp:binding:telegram:default:seed",
  })),
}));
const sessionMocks = vi.hoisted(() => ({
  recordSessionMetaFromInbound: vi.fn(),
  resolveStorePath: vi.fn(),
}));
const replyMocks = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcher: vi.fn<DispatchReplyWithBufferedBlockDispatcherFn>(
    async () => dispatchReplyResult,
  ),
}));
const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn<DeliverRepliesFn>(async () => ({ delivered: true })),
}));
const sessionBindingMocks = vi.hoisted(() => ({
  resolveByConversation: vi.fn<
    (ref: unknown) => { bindingId: string; targetSessionKey: string } | null
  >(() => null),
  touch: vi.fn(),
}));

vi.mock("../../../src/acp/persistent-bindings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/acp/persistent-bindings.js")>();
  return {
    ...actual,
    resolveConfiguredAcpBindingRecord: persistentBindingMocks.resolveConfiguredAcpBindingRecord,
    ensureConfiguredAcpBindingSession: persistentBindingMocks.ensureConfiguredAcpBindingSession,
  };
});
vi.mock("../../../src/config/sessions.js", () => ({
  recordSessionMetaFromInbound: sessionMocks.recordSessionMetaFromInbound,
  resolveStorePath: sessionMocks.resolveStorePath,
}));
vi.mock("../../../src/pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn(async () => []),
}));
vi.mock("../../../src/auto-reply/reply/inbound-context.js", () => ({
  finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
}));
vi.mock("../../../src/auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher: replyMocks.dispatchReplyWithBufferedBlockDispatcher,
}));
vi.mock("../../../src/channels/reply-prefix.js", () => ({
  createReplyPrefixOptions: vi.fn(() => ({ onModelSelected: () => {} })),
}));
vi.mock("../../../src/infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    bind: vi.fn(),
    getCapabilities: vi.fn(),
    listBySession: vi.fn(),
    resolveByConversation: (ref: unknown) => sessionBindingMocks.resolveByConversation(ref),
    touch: (bindingId: string, at?: number) => sessionBindingMocks.touch(bindingId, at),
    unbind: vi.fn(),
  }),
}));
vi.mock("../../../src/auto-reply/skill-commands.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/auto-reply/skill-commands.js")>();
  return { ...actual, listSkillCommandsForAgents: vi.fn(() => []) };
});
vi.mock("../../../src/plugins/commands.js", () => ({
  getPluginCommandSpecs: vi.fn(() => []),
  matchPluginCommand: vi.fn(() => null),
  executePluginCommand: vi.fn(async () => ({ text: "ok" })),
}));
vi.mock("./bot/delivery.js", () => ({
  deliverReplies: deliveryMocks.deliverReplies,
}));

type TelegramCommandHandler = (ctx: unknown) => Promise<void>;

function registerAndResolveStatusHandler(params: {
  cfg: OpenClawConfig;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  telegramCfg?: NativeCommandTestParams["telegramCfg"];
  resolveTelegramGroupConfig?: RegisterTelegramHandlerParams["resolveTelegramGroupConfig"];
}): {
  handler: TelegramCommandHandler;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const { cfg, allowFrom, groupAllowFrom, telegramCfg, resolveTelegramGroupConfig } = params;
  return registerAndResolveCommandHandlerBase({
    commandName: "status",
    cfg,
    allowFrom: allowFrom ?? ["*"],
    groupAllowFrom: groupAllowFrom ?? [],
    useAccessGroups: true,
    telegramCfg,
    resolveTelegramGroupConfig,
  });
}

function registerAndResolveCommandHandlerBase(params: {
  commandName: string;
  cfg: OpenClawConfig;
  allowFrom: string[];
  groupAllowFrom: string[];
  useAccessGroups: boolean;
  telegramCfg?: NativeCommandTestParams["telegramCfg"];
  resolveTelegramGroupConfig?: RegisterTelegramHandlerParams["resolveTelegramGroupConfig"];
}): {
  handler: TelegramCommandHandler;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const {
    commandName,
    cfg,
    allowFrom,
    groupAllowFrom,
    useAccessGroups,
    telegramCfg,
    resolveTelegramGroupConfig,
  } = params;
  const commandHandlers = new Map<string, TelegramCommandHandler>();
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  registerTelegramNativeCommands({
    ...createNativeCommandTestParams({
      bot: {
        api: {
          setMyCommands: vi.fn().mockResolvedValue(undefined),
          sendMessage,
        },
        command: vi.fn((name: string, cb: TelegramCommandHandler) => {
          commandHandlers.set(name, cb);
        }),
      } as unknown as NativeCommandTestParams["bot"],
      cfg,
      allowFrom,
      groupAllowFrom,
      useAccessGroups,
      telegramCfg,
      resolveTelegramGroupConfig,
    }),
  });

  const handler = commandHandlers.get(commandName);
  expect(handler).toBeTruthy();
  return { handler: handler as TelegramCommandHandler, sendMessage };
}

function registerAndResolveCommandHandler(params: {
  commandName: string;
  cfg: OpenClawConfig;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  useAccessGroups?: boolean;
  telegramCfg?: NativeCommandTestParams["telegramCfg"];
  resolveTelegramGroupConfig?: RegisterTelegramHandlerParams["resolveTelegramGroupConfig"];
}): {
  handler: TelegramCommandHandler;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const {
    commandName,
    cfg,
    allowFrom,
    groupAllowFrom,
    useAccessGroups,
    telegramCfg,
    resolveTelegramGroupConfig,
  } = params;
  return registerAndResolveCommandHandlerBase({
    commandName,
    cfg,
    allowFrom: allowFrom ?? [],
    groupAllowFrom: groupAllowFrom ?? [],
    useAccessGroups: useAccessGroups ?? true,
    telegramCfg,
    resolveTelegramGroupConfig,
  });
}

function createConfiguredAcpTopicBinding(boundSessionKey: string) {
  return {
    spec: {
      channel: "telegram",
      accountId: "default",
      conversationId: "-1001234567890:topic:42",
      parentConversationId: "-1001234567890",
      agentId: "codex",
      mode: "persistent",
    },
    record: {
      bindingId: "config:acp:telegram:default:-1001234567890:topic:42",
      targetSessionKey: boundSessionKey,
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1001234567890:topic:42",
        parentConversationId: "-1001234567890",
      },
      status: "active",
      boundAt: 0,
    },
  } satisfies import("../../../src/acp/persistent-bindings.js").ResolvedConfiguredAcpBinding;
}

function expectUnauthorizedNewCommandBlocked(sendMessage: ReturnType<typeof vi.fn>) {
  expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  expect(persistentBindingMocks.resolveConfiguredAcpBindingRecord).not.toHaveBeenCalled();
  expect(persistentBindingMocks.ensureConfiguredAcpBindingSession).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledWith(
    -1001234567890,
    "You are not authorized to use this command.",
    expect.objectContaining({ message_thread_id: 42 }),
  );
}

describe("registerTelegramNativeCommands — session metadata", () => {
  beforeEach(() => {
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockClear();
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReturnValue(null);
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockClear();
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockResolvedValue({
      ok: true,
      sessionKey: "agent:codex:acp:binding:telegram:default:seed",
    });
    sessionMocks.recordSessionMetaFromInbound.mockClear().mockResolvedValue(undefined);
    sessionMocks.resolveStorePath.mockClear().mockReturnValue("/tmp/openclaw-sessions.json");
    replyMocks.dispatchReplyWithBufferedBlockDispatcher
      .mockClear()
      .mockResolvedValue(dispatchReplyResult);
    sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
    sessionBindingMocks.touch.mockReset();
    deliveryMocks.deliverReplies.mockClear().mockResolvedValue({ delivered: true });
  });

  it("calls recordSessionMetaFromInbound after a native slash command", async () => {
    const cfg: OpenClawConfig = {};
    const { handler } = registerAndResolveStatusHandler({ cfg });
    await handler(createTelegramPrivateCommandContext());

    expect(sessionMocks.recordSessionMetaFromInbound).toHaveBeenCalledTimes(1);
    const call = (
      sessionMocks.recordSessionMetaFromInbound.mock.calls as unknown as Array<
        [{ sessionKey?: string; ctx?: { OriginatingChannel?: string; Provider?: string } }]
      >
    )[0]?.[0];
    expect(call?.ctx?.OriginatingChannel).toBe("telegram");
    expect(call?.ctx?.Provider).toBe("telegram");
    expect(call?.sessionKey).toBe("agent:main:telegram:slash:200");
  });

  it("awaits session metadata persistence before dispatch", async () => {
    const deferred = createDeferred<void>();
    sessionMocks.recordSessionMetaFromInbound.mockReturnValue(deferred.promise);

    const cfg: OpenClawConfig = {};
    const { handler } = registerAndResolveStatusHandler({ cfg });
    const runPromise = handler(createTelegramPrivateCommandContext());

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
      async ({ dispatcherOptions }: DispatchReplyWithBufferedBlockDispatcherParams) => {
        await dispatcherOptions.deliver(
          {
            text: "Mode: foreground\nRun: /approve 7f423fdc allow-once (or allow-always / deny).",
          },
          { kind: "final" },
        );
        return dispatchReplyResult;
      },
    );

    const { handler } = registerAndResolveStatusHandler({
      cfg: {
        channels: {
          telegram: {
            execApprovals: {
              enabled: true,
              approvers: ["12345"],
              target: "dm",
            },
          },
        },
      },
    });
    await handler(createTelegramPrivateCommandContext());

    const deliveredCall = deliveryMocks.deliverReplies.mock.calls[0]?.[0] as
      | DeliverRepliesParams
      | undefined;
    const deliveredPayload = deliveredCall?.replies?.[0];
    expect(deliveredPayload).toBeTruthy();
    expect(deliveredPayload?.["text"]).toContain("/approve 7f423fdc allow-once");
    expect(deliveredPayload?.["channelData"]).toBeUndefined();
  });

  it("suppresses local structured exec approval replies for native commands", async () => {
    replyMocks.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }: DispatchReplyWithBufferedBlockDispatcherParams) => {
        await dispatcherOptions.deliver(
          {
            text: "Approval required.\n\n```txt\n/approve 7f423fdc allow-once\n```",
            channelData: {
              execApproval: {
                approvalId: "7f423fdc-1111-2222-3333-444444444444",
                approvalSlug: "7f423fdc",
                allowedDecisions: ["allow-once", "allow-always", "deny"],
              },
            },
          },
          { kind: "tool" },
        );
        return dispatchReplyResult;
      },
    );

    const { handler } = registerAndResolveStatusHandler({
      cfg: {
        channels: {
          telegram: {
            execApprovals: {
              enabled: true,
              approvers: ["12345"],
              target: "dm",
            },
          },
        },
      },
    });
    await handler(createTelegramPrivateCommandContext());

    expect(deliveryMocks.deliverReplies).not.toHaveBeenCalled();
  });

  it("sends native command error replies silently when silentErrorReplies is enabled", async () => {
    replyMocks.dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }: DispatchReplyWithBufferedBlockDispatcherParams) => {
        await dispatcherOptions.deliver({ text: "oops", isError: true }, { kind: "final" });
        return dispatchReplyResult;
      },
    );

    const { handler } = registerAndResolveStatusHandler({
      cfg: {},
      telegramCfg: { silentErrorReplies: true },
    });
    await handler(createTelegramPrivateCommandContext());

    const deliveredCall = deliveryMocks.deliverReplies.mock.calls[0]?.[0] as
      | DeliverRepliesParams
      | undefined;
    expect(deliveredCall).toEqual(
      expect.objectContaining({
        silent: true,
        replies: [expect.objectContaining({ isError: true })],
      }),
    );
  });

  it("routes Telegram native commands through configured ACP topic bindings", async () => {
    const boundSessionKey = "agent:codex:acp:binding:telegram:default:feedface";
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReturnValue(
      createConfiguredAcpTopicBinding(boundSessionKey),
    );
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockResolvedValue({
      ok: true,
      sessionKey: boundSessionKey,
    });

    const { handler } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: ["200"],
      groupAllowFrom: ["200"],
    });
    await handler(createTelegramTopicCommandContext());

    expect(persistentBindingMocks.resolveConfiguredAcpBindingRecord).toHaveBeenCalledTimes(1);
    expect(persistentBindingMocks.ensureConfiguredAcpBindingSession).toHaveBeenCalledTimes(1);
    const dispatchCall = (
      replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls as unknown as Array<
        [{ ctx?: { CommandTargetSessionKey?: string } }]
      >
    )[0]?.[0];
    expect(dispatchCall?.ctx?.CommandTargetSessionKey).toBe(boundSessionKey);
    const sessionMetaCall = (
      sessionMocks.recordSessionMetaFromInbound.mock.calls as unknown as Array<
        [{ sessionKey?: string }]
      >
    )[0]?.[0];
    expect(sessionMetaCall?.sessionKey).toBe("agent:codex:telegram:slash:200");
  });

  it("routes Telegram native commands through topic-specific agent sessions", async () => {
    const { handler } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: ["200"],
      groupAllowFrom: ["200"],
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: { agentId: "zu" },
      }),
    });
    await handler(createTelegramTopicCommandContext());

    const dispatchCall = (
      replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls as unknown as Array<
        [{ ctx?: { CommandTargetSessionKey?: string } }]
      >
    )[0]?.[0];
    expect(dispatchCall?.ctx?.CommandTargetSessionKey).toBe(
      "agent:zu:telegram:group:-1001234567890:topic:42",
    );
  });

  it("routes Telegram native commands through bound topic sessions", async () => {
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "default:-1001234567890:topic:42",
      targetSessionKey: "agent:codex-acp:session-1",
    });

    const { handler } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: ["200"],
      groupAllowFrom: ["200"],
    });
    await handler(createTelegramTopicCommandContext());

    expect(sessionBindingMocks.resolveByConversation).toHaveBeenCalledWith({
      channel: "telegram",
      accountId: "default",
      conversationId: "-1001234567890:topic:42",
    });
    const dispatchCall = (
      replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls as unknown as Array<
        [{ ctx?: { CommandTargetSessionKey?: string } }]
      >
    )[0]?.[0];
    expect(dispatchCall?.ctx?.CommandTargetSessionKey).toBe("agent:codex-acp:session-1");
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith(
      "default:-1001234567890:topic:42",
      undefined,
    );
  });

  it("aborts native command dispatch when configured ACP topic binding cannot initialize", async () => {
    const boundSessionKey = "agent:codex:acp:binding:telegram:default:feedface";
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReturnValue(
      createConfiguredAcpTopicBinding(boundSessionKey),
    );
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockResolvedValue({
      ok: false,
      sessionKey: boundSessionKey,
      error: "gateway unavailable",
    });

    const { handler, sendMessage } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: ["200"],
      groupAllowFrom: ["200"],
    });
    await handler(createTelegramTopicCommandContext());

    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      -1001234567890,
      "Configured ACP binding is unavailable right now. Please try again.",
      expect.objectContaining({ message_thread_id: 42 }),
    );
  });

  it("keeps /new blocked in ACP-bound Telegram topics when sender is unauthorized", async () => {
    const boundSessionKey = "agent:codex:acp:binding:telegram:default:feedface";
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReturnValue(
      createConfiguredAcpTopicBinding(boundSessionKey),
    );
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockResolvedValue({
      ok: true,
      sessionKey: boundSessionKey,
    });

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "new",
      cfg: {},
      allowFrom: [],
      groupAllowFrom: [],
      useAccessGroups: true,
    });
    await handler(createTelegramTopicCommandContext());

    expectUnauthorizedNewCommandBlocked(sendMessage);
  });

  it("keeps /new blocked for unbound Telegram topics when sender is unauthorized", async () => {
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReturnValue(null);

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "new",
      cfg: {},
      allowFrom: [],
      groupAllowFrom: [],
      useAccessGroups: true,
    });
    await handler(createTelegramTopicCommandContext());

    expectUnauthorizedNewCommandBlocked(sendMessage);
  });
});
