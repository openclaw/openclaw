import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordPendingDiscussionOpen,
  reserveDiscussionBindingGeneration,
} from "./discussions/binding-generation.js";
import {
  getClickClackDiscussionBindingStore,
  type ClickClackDiscussionBinding,
} from "./discussions/binding-store.js";
import { markClickClackDiscussionChannelRevoked } from "./discussions/revoked-channel-store.js";
import { handleClickClackInbound } from "./inbound.js";
import {
  createInboundRuntime,
  publishInboundAccountConfig as publishAccountConfig,
  createInboundMessage as createMessage,
  createInboundDiscussionBinding,
  createInboundDiscussionConfig,
} from "./inbound.test-support.js";
import { setClickClackRuntime } from "./runtime.js";
import type { ClickClackMessage, CoreConfig, ResolvedClickClackAccount } from "./types.js";

const sendClickClackTextMock = vi.hoisted(() => vi.fn());
const VALID_MESSAGE_ID = "msg_01arz3ndektsv4rrffq69g5fav";
const SECOND_VALID_MESSAGE_ID = "msg_01arz3ndektsv4rrffq69g5faw";
const THIRD_VALID_MESSAGE_ID = "msg_01arz3ndektsv4rrffq69g5fax";

vi.mock("./outbound.js", () => ({
  sendClickClackText: sendClickClackTextMock,
}));

function createRuntime(): PluginRuntime {
  return createInboundRuntime(true);
}

function createAgentAccount(
  overrides: Partial<ResolvedClickClackAccount> = {},
): ResolvedClickClackAccount {
  const base = {
    accountId: "default",
    enabled: true,
    configured: true,
    baseUrl: "http://127.0.0.1:8080",
    apiEndpoint: "http://127.0.0.1:8080",
    token: "test-token-placeholder",
    workspace: "wsp_1",
    replyMode: "agent",
    toolsAllow: [],
    defaultTo: "channel:general",
    allowFrom: ["*"],
    allowBots: false,
    reconnectMs: 1_500,
    agentActivity: false,
    nativeProgress: false,
    commandMenu: true,
    discussions: { enabled: false, workspace: "wsp_1", section: "Sessions" },
    requireMention: false,
    mentionPatterns: [],
    groups: {},
    config: {
      allowFrom: ["*"],
    },
  } satisfies ResolvedClickClackAccount;

  return {
    ...base,
    ...overrides,
    config: {
      ...base.config,
      workspace: overrides.workspace ?? base.workspace,
      botUserId: overrides.botUserId,
      ...overrides.config,
    },
  };
}

describe("handleClickClackInbound", () => {
  beforeEach(() => {
    sendClickClackTextMock.mockReset();
  });

  it("logs and skips delivery when model mode produces no sendable text", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.llm.complete).mockResolvedValue({
      text: "   ",
      provider: "openai",
      model: "gpt-5.4-mini",
      agentId: "service-bot",
      usage: {},
      execution: {
        mode: "direct-provider",
        owner: { kind: "provider", id: "openai" },
      },
      audit: { caller: { kind: "plugin", id: "clickclack" } },
    });
    setClickClackRuntime(runtime);
    const account = createAgentAccount({
      accountId: "service",
      agentId: "service-bot",
      replyMode: "model",
    });
    publishAccountConfig(runtime, account);

    await handleClickClackInbound({
      account,
      config: {} satisfies CoreConfig,
      message: createMessage({ body: "hello bot" }),
    });

    expect(sendClickClackTextMock).not.toHaveBeenCalled();
    expect(runtime.logging.getChildLogger).toHaveBeenCalledWith({
      plugin: "clickclack",
      feature: "model-reply",
    });
    const logger = vi.mocked(runtime.logging.getChildLogger).mock.results[0]?.value;
    expect(logger?.warn).toHaveBeenCalledWith(
      "[service] ClickClack model reply produced no sendable text",
    );
  });

  it("keeps native progress opt-in and durable activity independent", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const cfg = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4-mini",
        },
      },
    } satisfies CoreConfig;
    const defaultAccount = createAgentAccount();
    const nativeProgressAccount = createAgentAccount({ nativeProgress: true });
    const agentActivityAccount = createAgentAccount({ agentActivity: true });

    publishAccountConfig(runtime, defaultAccount, cfg);
    await handleClickClackInbound({
      account: defaultAccount,
      config: cfg,
      message: createMessage({
        id: VALID_MESSAGE_ID,
        thread_root_id: VALID_MESSAGE_ID,
      }),
    });
    publishAccountConfig(runtime, nativeProgressAccount, cfg);
    await handleClickClackInbound({
      account: nativeProgressAccount,
      config: cfg,
      message: createMessage({
        id: SECOND_VALID_MESSAGE_ID,
        thread_root_id: SECOND_VALID_MESSAGE_ID,
      }),
    });
    publishAccountConfig(runtime, agentActivityAccount, cfg);
    await handleClickClackInbound({
      account: agentActivityAccount,
      config: cfg,
      message: createMessage({
        id: THIRD_VALID_MESSAGE_ID,
        thread_root_id: THIRD_VALID_MESSAGE_ID,
      }),
    });

    const dispatchTurn = vi.mocked(runtime.channel.inbound.dispatch);
    expect(dispatchTurn).toHaveBeenCalledTimes(3);
    const [withoutOptIn, withNativeOnly, withActivityOnly] = dispatchTurn.mock.calls.map(
      ([call]) => call as { replyOptions?: Record<string, unknown> },
    );
    expect(withoutOptIn?.replyOptions?.runId).toBe(`clickclack:${VALID_MESSAGE_ID}`);
    expect(withoutOptIn?.replyOptions?.onItemEvent).toBeUndefined();
    expect(withoutOptIn?.replyOptions?.commentaryProgressEnabled).toBeUndefined();
    expect(withNativeOnly?.replyOptions?.runId).toBe(`clickclack:${SECOND_VALID_MESSAGE_ID}`);
    expect(typeof withNativeOnly?.replyOptions?.onItemEvent).toBe("function");
    expect(withNativeOnly?.replyOptions?.commentaryProgressEnabled).toBe(true);
    expect(withActivityOnly?.replyOptions?.runId).toBe(`clickclack:${THIRD_VALID_MESSAGE_ID}`);
    expect(typeof withActivityOnly?.replyOptions?.onItemEvent).toBe("function");
    expect(typeof withActivityOnly?.replyOptions?.onModelSelected).toBe("function");
  });

  it("maps the authoritative message id to the agent run and correlates the final reply", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const account = createAgentAccount();
    publishAccountConfig(runtime, account);

    await handleClickClackInbound({
      account,
      config: {} as CoreConfig,
      message: createMessage({
        id: VALID_MESSAGE_ID,
        thread_root_id: VALID_MESSAGE_ID,
      }),
      correlationId: "fakeco.case_2",
    });

    const dispatchParams = vi.mocked(runtime.channel.inbound.dispatch).mock.calls[0]?.[0];
    expect(dispatchParams?.replyOptions?.runId).toBe(`clickclack:${VALID_MESSAGE_ID}`);

    await dispatchParams?.delivery.deliver({ text: "correlated reply" }, {} as never);

    expect(sendClickClackTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "fakeco.case_2",
        replyToId: VALID_MESSAGE_ID,
        text: "correlated reply",
      }),
    );
  });

  it("routes media replies through required durable delivery", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const account = createAgentAccount();
    publishAccountConfig(runtime, account);

    await handleClickClackInbound({
      account,
      config: {} as CoreConfig,
      message: createMessage({
        id: VALID_MESSAGE_ID,
        thread_root_id: VALID_MESSAGE_ID,
      }),
    });

    const delivery = vi.mocked(runtime.channel.inbound.dispatch).mock.calls[0]?.[0].delivery;
    if (typeof delivery?.durable !== "function") {
      throw new Error("expected ClickClack media durable delivery resolver");
    }
    const payload = { text: "artifact", mediaUrl: "/workspace/artifact.txt" };
    expect(delivery.durable(payload, { kind: "final" } as never)).toEqual({
      to: "channel:chn_1",
      threadId: undefined,
      replyToId: VALID_MESSAGE_ID,
      requiredCapabilities: {
        text: true,
        media: true,
        replyTo: true,
        messageSendingHooks: true,
        reconcileUnknownSend: true,
      },
    });
    await expect(delivery?.deliver(payload, { kind: "final" } as never)).rejects.toThrow(
      "ClickClack media reply requires durable delivery",
    );
    expect(sendClickClackTextMock).not.toHaveBeenCalled();
  });

  it("accepts ClickClack DM target syntax in allowFrom", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.channel.commands.shouldComputeCommandAuthorized).mockReturnValue(true);
    setClickClackRuntime(runtime);
    const cfg = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4-mini",
        },
      },
    } satisfies CoreConfig;
    const account = createAgentAccount({
      allowFrom: ["dm:usr_owner"],
      config: { allowFrom: ["dm:usr_owner"] },
    });
    publishAccountConfig(runtime, account, cfg);

    await handleClickClackInbound({
      account,
      config: cfg,
      message: createMessage({
        channel_id: "",
        direct_conversation_id: "dcn_1",
      }),
    });

    const dispatchTurn = vi.mocked(runtime.channel.inbound.dispatch);
    expect(dispatchTurn).toHaveBeenCalledTimes(1);
    expect(dispatchTurn.mock.calls[0]?.[0].ctxPayload.ChatType).toBe("direct");
    expect(dispatchTurn.mock.calls[0]?.[0].ctxPayload.CommandAuthorized).toBe(true);
  });

  it("preserves session policy when an account overrides the routed agent", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const cfg = {
      session: {
        dmScope: "per-channel-peer",
        mainKey: "work",
        identityLinks: { alice: ["clickclack:dm:usr_owner"] },
      },
      bindings: [
        {
          agentId: "binding-agent",
          match: {
            channel: "clickclack",
            accountId: "default",
            peer: { kind: "direct", id: "dm:usr_owner" },
          },
          session: { dmScope: "per-account-channel-peer" },
        },
      ],
    } satisfies CoreConfig;
    const account = createAgentAccount({ agentId: "service-bot" });
    publishAccountConfig(runtime, account, cfg);

    await handleClickClackInbound({
      account,
      config: cfg,
      message: createMessage({
        channel_id: undefined,
        direct_conversation_id: "dcn_1",
      }),
    });

    const dispatchTurn = vi.mocked(runtime.channel.inbound.dispatch);
    expect(dispatchTurn.mock.calls[0]?.[0].route.sessionKey).toBe(
      "agent:service-bot:clickclack:direct:alice",
    );
    expect(runtime.channel.routing.buildAgentSessionKey).toHaveBeenCalledWith({
      agentId: "service-bot",
      mainKey: "work",
      channel: "clickclack",
      accountId: "default",
      peer: { kind: "direct", id: "dm:usr_owner" },
      dmScope: "per-channel-peer",
      identityLinks: { alice: ["clickclack:dm:usr_owner"] },
    });
  });

  it("rotates an old attachment before dispatch after the main session is replaced", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const mainSessionKey = "agent:research:main";
    await getClickClackDiscussionBindingStore(runtime).setIfCurrent(
      mainSessionKey,
      undefined,
      createInboundDiscussionBinding({ sessionId: "old-session-id", archived: true }),
    );

    const currentConfig = createInboundDiscussionConfig() satisfies CoreConfig;
    vi.mocked(runtime.config.current).mockReturnValue(currentConfig);
    await handleClickClackInbound({
      account: createAgentAccount({
        replyMode: "model",
        discussions: { enabled: true, workspace: "wsp_1", section: "Sessions" },
      }),
      config: currentConfig,
      message: createMessage({ channel_id: "chn_1", body: "Old discussion" }),
    });

    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(1);
    const dispatched = vi.mocked(runtime.channel.inbound.dispatch).mock.calls[0]?.[0];
    expect(dispatched?.route.agentId).toBe("research");
    expect(dispatched?.route.sessionKey).toMatch(
      /^agent:research:clickclack:channel:disc-[0-9a-f]{32}$/u,
    );
    expect(dispatched?.ctxPayload.GroupSystemPrompt).toContain(mainSessionKey);
    expect(dispatched?.ctxPayload.GroupSystemPrompt).toContain("sessions_history");
    expect(dispatched?.ctxPayload.GroupSystemPrompt).toContain("sessions_send");
    expect(getClickClackDiscussionBindingStore(runtime).get(mainSessionKey)).toMatchObject({
      sessionId: "session-id",
      channelId: "chn_1",
      externalRef: "openclaw:test:research",
    });
  });

  it("drops inbound delivery as soon as the main session is archived", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    vi.mocked(runtime.agent.session.getSessionEntry).mockReturnValue({
      sessionId: "session-id",
      updatedAt: 2,
      archivedAt: 1,
    });
    await getClickClackDiscussionBindingStore(runtime).setIfCurrent(
      "agent:research:main",
      undefined,
      createInboundDiscussionBinding(),
    );

    const currentConfig = createInboundDiscussionConfig() satisfies CoreConfig;
    vi.mocked(runtime.config.current).mockReturnValue(currentConfig);
    await handleClickClackInbound({
      account: createAgentAccount({
        replyMode: "model",
        discussions: { enabled: true, workspace: "wsp_1", section: "Sessions" },
      }),
      config: currentConfig,
      message: createMessage({ channel_id: "chn_1", body: "Archived before sync" }),
    });

    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("drops a persisted managed channel after discussions are disabled", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    await getClickClackDiscussionBindingStore(runtime).setIfCurrent(
      "agent:research:main",
      undefined,
      createInboundDiscussionBinding(),
    );

    const currentConfig = {} satisfies CoreConfig;
    vi.mocked(runtime.config.current).mockReturnValue(currentConfig);
    await handleClickClackInbound({
      account: createAgentAccount({ replyMode: "model" }),
      config: currentConfig,
      message: createMessage({ channel_id: "chn_1", body: "Use the normal route" }),
    });

    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("drops delayed inbound after the live binding has been released", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const mainSessionKey = "agent:research:released";
    const binding: ClickClackDiscussionBinding = createInboundDiscussionBinding({
      externalRef: "openclaw:test:released",
      label: "Released",
    });
    const bindingStore = getClickClackDiscussionBindingStore(runtime);
    await bindingStore.setIfCurrent(mainSessionKey, undefined, binding);
    await markClickClackDiscussionChannelRevoked(runtime, mainSessionKey, binding);
    await bindingStore.deleteIfCurrent(mainSessionKey, binding);

    const currentConfig = {} satisfies CoreConfig;
    vi.mocked(runtime.config.current).mockReturnValue(currentConfig);
    await handleClickClackInbound({
      account: createAgentAccount({ replyMode: "model" }),
      config: currentConfig,
      message: createMessage({ channel_id: "chn_1", body: "Delayed managed event" }),
    });

    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("does not lose managed ownership when the local account id changes", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    await getClickClackDiscussionBindingStore(runtime).setIfCurrent(
      "agent:research:main",
      undefined,
      createInboundDiscussionBinding({
        externalRef: "openclaw:test:renamed-account",
        label: "Renamed account",
      }),
    );

    const currentConfig = {} satisfies CoreConfig;
    vi.mocked(runtime.config.current).mockReturnValue(currentConfig);
    await handleClickClackInbound({
      account: createAgentAccount({ accountId: "replacement", replyMode: "model" }),
      config: currentConfig,
      message: createMessage({ channel_id: "chn_1", body: "Old managed channel" }),
    });

    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("quarantines unbound channel events while a create outcome is ambiguous", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const account = createAgentAccount({ replyMode: "model" });
    publishAccountConfig(runtime, account);
    const sessionKey = "agent:research:pending";
    const generation = await reserveDiscussionBindingGeneration({
      runtime,
      sessionKey,
      accountId: "default",
      credentialFingerprint: "test-fingerprint",
      destinationIdentity: "http://127.0.0.1:8080\0wsp_1",
      createGeneration: () => "pending-generation",
    });
    await recordPendingDiscussionOpen({
      runtime,
      sessionKey,
      generation,
      pending: {
        accountId: "default",
        serverBaseUrl: "http://127.0.0.1:8080",
        workspaceId: "wsp_1",
        sessionId: "session-id",
        externalRef: "openclaw:test:pending",
        credentialFingerprint: "test-fingerprint",
      },
    });

    await handleClickClackInbound({
      account,
      config: {} satisfies CoreConfig,
      message: createMessage({ channel_id: "chn_unknown", body: "Maybe managed" }),
    });

    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("drops a managed channel after the discussion workspace changes", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    await getClickClackDiscussionBindingStore(runtime).setIfCurrent(
      "agent:research:main",
      undefined,
      createInboundDiscussionBinding(),
    );
    const account = createAgentAccount({
      replyMode: "model",
      discussions: { enabled: true, workspace: "wsp_2", section: "Sessions" },
    });

    const currentConfig = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: account.baseUrl,
          token: account.token,
          workspace: "wsp_2",
          replyMode: "model",
          discussions: { enabled: true, workspace: "wsp_2" },
        },
      },
    } satisfies CoreConfig;
    vi.mocked(runtime.config.current).mockReturnValue(currentConfig);
    await handleClickClackInbound({
      account,
      config: currentConfig,
      message: createMessage({ channel_id: "chn_1", body: "Use the normal route" }),
    });

    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("preserves binding scope for a canonically equivalent account agent", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const cfg = {
      agents: { entries: { "service-bot": {} } },
      session: { dmScope: "main" },
      bindings: [
        {
          agentId: "service-bot",
          match: {
            channel: "clickclack",
            accountId: "default",
            peer: { kind: "direct", id: "dm:usr_owner" },
          },
          session: { dmScope: "per-account-channel-peer" },
        },
      ],
    } satisfies CoreConfig;
    const account = createAgentAccount({ agentId: "SERVICE-BOT" });
    publishAccountConfig(runtime, account, cfg);

    await handleClickClackInbound({
      account,
      config: cfg,
      message: createMessage({
        channel_id: undefined,
        direct_conversation_id: "dcn_1",
      }),
    });

    const dispatchTurn = vi.mocked(runtime.channel.inbound.dispatch);
    expect(dispatchTurn.mock.calls[0]?.[0]).toMatchObject({
      route: {
        agentId: "service-bot",
        sessionKey: "agent:service-bot:clickclack:default:direct:dm:usr_owner",
      },
    });
  });

  it("does not dispatch agent turns from senders outside allowFrom", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.channel.commands.shouldComputeCommandAuthorized).mockReturnValue(true);
    setClickClackRuntime(runtime);
    const cfg = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4-mini",
        },
      },
    } satisfies CoreConfig;
    const account = createAgentAccount({
      allowFrom: ["usr_owner"],
      config: { allowFrom: ["usr_owner"] },
    });
    publishAccountConfig(runtime, account, cfg);

    await handleClickClackInbound({
      account,
      config: cfg,
      message: createMessage({
        author_id: "usr_attacker",
        author: {
          id: "usr_attacker",
          kind: "human",
          display_name: "Attacker",
          handle: "attacker",
          avatar_url: "",
          created_at: "2026-05-09T12:00:00.000Z",
        },
      }),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });
});

function createModelRuntime(text = "service bot online"): PluginRuntime {
  return createPluginRuntimeMock({
    llm: {
      complete: vi.fn<PluginRuntime["llm"]["complete"]>().mockResolvedValue({
        text,
        provider: "openai",
        model: "gpt-5.6-luna",
        agentId: "service-bot",
        usage: {},
        execution: {
          mode: "direct-provider",
          owner: { kind: "provider", id: "openai" },
        },
        audit: { caller: { kind: "plugin", id: "clickclack" } },
      }),
    },
  });
}

function createModelAccount(): ResolvedClickClackAccount {
  return {
    accountId: "model-loop-account",
    enabled: true,
    configured: true,
    baseUrl: "http://127.0.0.1:8080",
    apiEndpoint: "http://127.0.0.1:8080",
    token: "test-token-placeholder",
    workspace: "wsp_model_loop",
    botUserId: "usr_model_receiver",
    agentId: "service-bot",
    replyMode: "model",
    toolsAllow: [],
    defaultTo: "channel:general",
    allowFrom: ["usr_model_sender"],
    allowBots: true,
    botLoopProtection: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 },
    reconnectMs: 1_500,
    agentActivity: false,
    nativeProgress: false,
    commandMenu: true,
    discussions: { enabled: false, workspace: "wsp_model_loop", section: "Sessions" },
    config: { workspace: "wsp_model_loop" },
    requireMention: false,
    mentionPatterns: [],
    groups: {},
  };
}

describe("ClickClack direct-model response prefix", () => {
  beforeEach(() => {
    sendClickClackTextMock.mockClear();
  });

  function createModelMessage(): ClickClackMessage {
    return {
      id: "msg_01arz3ndektsv4rrffq69g5fca",
      workspace_id: "wsp_model_loop",
      direct_conversation_id: "dm_model_prefix",
      author_id: "usr_model_sender",
      thread_root_id: "msg_01arz3ndektsv4rrffq69g5fca",
      body: "hello bot",
      body_format: "markdown",
      created_at: "2026-05-09T12:00:00.000Z",
      author: {
        id: "usr_model_sender",
        kind: "human",
        display_name: "Model sender",
        handle: "model-sender",
        avatar_url: "",
        created_at: "2026-05-09T12:00:00.000Z",
      },
    };
  }

  it("renders root, account, and templated prefixes on model replies", async () => {
    const cases = [
      {
        label: "root",
        cfg: { channels: { clickclack: { responsePrefix: "[bot]" } } },
        expected: "[bot] service bot online",
      },
      {
        label: "account",
        cfg: {
          channels: {
            clickclack: {
              responsePrefix: "[root]",
              accounts: { "model-loop-account": { responsePrefix: "[svc]" } },
            },
          },
        },
        expected: "[svc] service bot online",
      },
      {
        label: "templated",
        cfg: { channels: { clickclack: { responsePrefix: "[{model}]" } } },
        expected: "[gpt-5.6-luna] service bot online",
      },
      {
        label: "empty account override",
        cfg: {
          channels: {
            clickclack: {
              responsePrefix: "[root]",
              accounts: { "model-loop-account": { responsePrefix: "" } },
            },
          },
        },
        expected: "service bot online",
      },
      {
        label: "identity",
        cfg: {
          agents: { entries: { "service-bot": { identity: { name: "Service Bot" } } } },
          channels: { clickclack: { responsePrefix: "auto" } },
        },
        expected: "[Service Bot] service bot online",
      },
    ];

    for (const testCase of cases) {
      sendClickClackTextMock.mockClear();
      const runtime = createModelRuntime();
      const account = createModelAccount();
      publishAccountConfig(runtime, account, testCase.cfg);
      setClickClackRuntime(runtime);
      await handleClickClackInbound({
        account,
        config: testCase.cfg,
        message: createModelMessage(),
      });

      expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
      expect(runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
      expect(vi.mocked(runtime.llm.complete).mock.calls[0]?.[0]).not.toHaveProperty("maxTokens");
      expect(sendClickClackTextMock.mock.calls[0]?.[0]?.text, testCase.label).toBe(
        testCase.expected,
      );
    }
  });

  it("does not add a second prefix when the completion already opens with one", async () => {
    sendClickClackTextMock.mockClear();
    const runtime = createModelRuntime("[bot] service bot online");
    const account = createModelAccount();
    const config = { channels: { clickclack: { responsePrefix: "[bot]" } } };
    publishAccountConfig(runtime, account, config);
    setClickClackRuntime(runtime);
    await handleClickClackInbound({
      account,
      config,
      message: createModelMessage(),
    });
    expect(sendClickClackTextMock.mock.calls[0]?.[0]?.text).toBe("[bot] service bot online");
  });
});

describe("ClickClack direct-model bot loop protection", () => {
  beforeEach(() => {
    sendClickClackTextMock.mockClear();
  });

  it("suppresses the second bot message before model completion", async () => {
    const runtime = createModelRuntime();
    setClickClackRuntime(runtime);
    const account = createModelAccount();
    publishAccountConfig(runtime, account);
    const message = {
      id: "msg_01arz3ndektsv4rrffq69g5fbx",
      workspace_id: "wsp_model_loop",
      direct_conversation_id: "dm_model_loop_suppression",
      author_id: "usr_model_sender",
      thread_root_id: "msg_01arz3ndektsv4rrffq69g5fbx",
      body: "hello from the other bot",
      body_format: "markdown" as const,
      created_at: "2026-05-09T12:00:00.000Z",
      author: {
        id: "usr_model_sender",
        kind: "bot" as const,
        display_name: "Model sender",
        handle: "model-sender",
        avatar_url: "",
        created_at: "2026-05-09T12:00:00.000Z",
      },
    } satisfies ClickClackMessage;

    await handleClickClackInbound({
      account,
      config: {} as CoreConfig,
      message,
    });
    await handleClickClackInbound({
      account,
      config: {} as CoreConfig,
      message: { ...message, id: "msg_01arz3ndektsv4rrffq69g5fby" },
    });

    expect(runtime.llm.complete).toHaveBeenCalledTimes(1);
    expect(sendClickClackTextMock).toHaveBeenCalledTimes(1);
  });

  it("retries the same bot message without consuming another loop slot", async () => {
    const runtime = createModelRuntime();
    const complete = vi.mocked(runtime.llm.complete);
    complete.mockRejectedValueOnce(new Error("transient model failure"));
    setClickClackRuntime(runtime);
    const account = createModelAccount();
    publishAccountConfig(runtime, account);
    const message = {
      id: "msg_01arz3ndektsv4rrffq69g5fbz",
      workspace_id: "wsp_model_loop",
      direct_conversation_id: "dm_model_loop_retry",
      author_id: "usr_model_sender",
      thread_root_id: "msg_01arz3ndektsv4rrffq69g5fbz",
      body: "retry this message",
      body_format: "markdown" as const,
      created_at: "2026-05-09T12:00:00.000Z",
      author: {
        id: "usr_model_sender",
        kind: "bot" as const,
        display_name: "Model sender",
        handle: "model-sender",
        avatar_url: "",
        created_at: "2026-05-09T12:00:00.000Z",
      },
    } satisfies ClickClackMessage;

    await expect(
      handleClickClackInbound({ account, config: {} as CoreConfig, message }),
    ).rejects.toThrow("transient model failure");
    await handleClickClackInbound({ account, config: {} as CoreConfig, message });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(sendClickClackTextMock).toHaveBeenCalledTimes(1);
  });
});
