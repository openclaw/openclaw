import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { resolveClickClackInboundAccess } from "./access.js";
import {
  getClickClackDiscussionBindingStore,
  type ClickClackDiscussionBinding,
} from "./discussions/binding-store.js";
import { handleClickClackInbound } from "./inbound.js";
import {
  createInboundRuntime,
  createInboundMessage as createMessage,
  createInboundDiscussionBinding,
  createInboundDiscussionConfig,
} from "./inbound.test-support.js";
import { setClickClackRuntime } from "./runtime.js";
import type { ClickClackUser, CoreConfig, ResolvedClickClackAccount } from "./types.js";

function createRuntime(): PluginRuntime {
  return createInboundRuntime(false);
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
    botUserId: "usr_receiver",
    botHandle: "blackbird",
    allowBots: false,
    reconnectMs: 1_500,
    agentActivity: false,
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
      ...overrides.config,
    },
  };
}

function createAuthor(overrides: Partial<ClickClackUser> = {}): ClickClackUser {
  return {
    id: "usr_owner",
    kind: "human",
    display_name: "Peter",
    handle: "steipete",
    avatar_url: "",
    created_at: "2026-05-09T12:00:00.000Z",
    ...overrides,
  };
}

describe("ClickClack inbound mention gating", () => {
  it("records attachment persistence failures before dropping inbound delivery", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const mainSessionKey = "agent:research:main";
    const bindingStore = getClickClackDiscussionBindingStore(runtime);
    bindingStore.set(
      mainSessionKey,
      createInboundDiscussionBinding({ sessionId: "old-session-id" }),
    );
    const persisted = runtime.state.openSyncKeyedStore<ClickClackDiscussionBinding>({
      namespace: "discussion-bindings",
      maxEntries: 10_000,
      overflowPolicy: "reject-new",
    });
    persisted.register = vi.fn(() => {
      throw new Error("SQLITE_FULL");
    });

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

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(bindingStore.get(mainSessionKey)).toMatchObject({ sessionId: "old-session-id" });
    expect(runtime.logging.getChildLogger).toHaveBeenCalledWith({
      plugin: "clickclack",
      feature: "discussions",
    });
    const loggerCall = vi
      .mocked(runtime.logging.getChildLogger)
      .mock.calls.findIndex(
        ([context]) => context?.plugin === "clickclack" && context.feature === "discussions",
      );
    const logger = vi.mocked(runtime.logging.getChildLogger).mock.results[loggerCall]?.value;
    expect(logger?.warn).toHaveBeenCalledWith(
      "discussion attachment refresh failed for channel chn_1: Error: SQLITE_FULL",
    );
  });

  it("ignores bot-authored messages by default", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({ allowFrom: ["usr_sender"] }),
      config: {} satisfies CoreConfig,
      message: createMessage({
        author_id: "usr_sender",
        author: createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" }),
      }),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("preserves legacy inbound delivery when the message omits author kind", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({ allowFrom: ["*"] }),
      config: {} satisfies CoreConfig,
      message: createMessage({
        author: undefined,
      }),
    });

    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(["agent_commentary", "agent_tool"] as const)(
    "does not dispatch ClickClack %s activity rows as bot prompts",
    async (kind) => {
      const runtime = createRuntime();
      setClickClackRuntime(runtime);

      await handleClickClackInbound({
        account: createAgentAccount({ allowFrom: ["usr_sender"], allowBots: true }),
        config: {} satisfies CoreConfig,
        message: createMessage({
          author_id: "usr_sender",
          kind,
          author: createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" }),
        }),
      });

      expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
      expect(runtime.llm.complete).not.toHaveBeenCalled();
    },
  );

  it("dispatches an allowed bot-authored message through the shared loop guard", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({ allowFrom: ["usr_sender"], allowBots: true }),
      config: {
        channels: { defaults: { botLoopProtection: { maxEventsPerWindow: 7 } } },
      } satisfies CoreConfig,
      message: createMessage({
        author_id: "usr_sender",
        author: createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" }),
      }),
    });

    const dispatch = vi.mocked(runtime.channel.inbound.dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0].botLoopProtection).toMatchObject({
      scopeId: "wsp_1",
      conversationId: "chn_1",
      senderId: "usr_sender",
      receiverId: "usr_receiver",
      eventId: "msg_1",
      defaultsConfig: { maxEventsPerWindow: 7 },
      defaultEnabled: true,
    });
  });

  it("isolates bot loop budgets by ClickClack thread root", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const account = createAgentAccount({ allowFrom: ["usr_sender"], allowBots: true });
    const author = createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" });

    const threadA = await resolveClickClackInboundAccess({
      account,
      config: {} satisfies CoreConfig,
      message: createMessage({
        id: "msg_thread_a_reply",
        author_id: "usr_sender",
        parent_message_id: "msg_thread_a",
        thread_root_id: "msg_thread_a",
        author,
      }),
    });
    const threadB = await resolveClickClackInboundAccess({
      account,
      config: {} satisfies CoreConfig,
      message: createMessage({
        id: "msg_thread_b_reply",
        author_id: "usr_sender",
        parent_message_id: "msg_thread_b",
        thread_root_id: "msg_thread_b",
        author,
      }),
    });

    expect(threadA.botLoopProtection?.conversationId).toBe("msg_thread_a");
    expect(threadB.botLoopProtection?.conversationId).toBe("msg_thread_b");
  });

  it("does not let bot opt-in bypass the wildcard human allowFrom default", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({ allowFrom: ["*"], allowBots: true }),
      config: {} satisfies CoreConfig,
      message: createMessage({
        author_id: "usr_sender",
        author: createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" }),
      }),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("shares bot-loop scope across accounts and preserves ClickClack event time", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const firstMessage = createMessage({
      author_id: "usr_sender",
      author: createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" }),
      created_at: "2026-05-09T12:00:00.000Z",
    });

    const accountA = await resolveClickClackInboundAccess({
      account: createAgentAccount({
        accountId: "account-a",
        allowFrom: ["usr_sender"],
        allowBots: true,
      }),
      config: {} satisfies CoreConfig,
      message: firstMessage,
    });
    const accountB = await resolveClickClackInboundAccess({
      account: createAgentAccount({
        accountId: "account-b",
        allowFrom: ["usr_sender"],
        allowBots: true,
      }),
      config: {} satisfies CoreConfig,
      message: firstMessage,
    });
    const delayedReplay = await resolveClickClackInboundAccess({
      account: createAgentAccount({
        accountId: "account-a",
        allowFrom: ["usr_sender"],
        allowBots: true,
      }),
      config: {} satisfies CoreConfig,
      message: { ...firstMessage, created_at: "2026-05-09T12:02:00.000Z" },
    });

    expect(accountA.botLoopProtection).toMatchObject({
      scopeId: "wsp_1",
      nowMs: Date.parse("2026-05-09T12:00:00.000Z"),
    });
    expect(accountB.botLoopProtection?.scopeId).toBe(accountA.botLoopProtection?.scopeId);
    expect(delayedReplay.botLoopProtection?.nowMs).toBe(Date.parse("2026-05-09T12:02:00.000Z"));
  });

  it("requires a mention for bot-authored group messages in mention mode", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({ allowFrom: ["usr_sender"], allowBots: "mentions" }),
      config: {} satisfies CoreConfig,
      message: createMessage({
        author_id: "usr_sender",
        body: "hello from another agent",
        author: createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" }),
      }),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("allows mentioned bot-authored group messages in mention mode", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({ allowFrom: ["usr_sender"], allowBots: "mentions" }),
      config: {} satisfies CoreConfig,
      message: createMessage({
        author_id: "usr_sender",
        body: "@blackbird please coordinate",
        author: createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" }),
      }),
    });

    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(1);
  });

  it("allows bot-authored direct messages in mention mode without a mention", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({ allowFrom: ["usr_sender"], allowBots: "mentions" }),
      config: {} satisfies CoreConfig,
      message: createMessage({
        author_id: "usr_sender",
        channel_id: undefined,
        direct_conversation_id: "dm_1",
        body: "hello directly",
        author: createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" }),
      }),
    });

    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not let wildcard group bot policy authorize direct messages", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({
        allowFrom: ["usr_sender"],
        allowBots: false,
        groups: { "*": { allowBots: "mentions" } },
      }),
      config: {} satisfies CoreConfig,
      message: createMessage({
        author_id: "usr_sender",
        channel_id: undefined,
        direct_conversation_id: "dm_1",
        body: "hello directly",
        author: createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" }),
      }),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("rejects an unmentioned group message when mention gating is enabled", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({
        requireMention: true,
        botHandle: "blackbird",
      }),
      config: {} satisfies CoreConfig,
      message: createMessage({ body: "hello everyone" }),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(runtime.llm.complete).not.toHaveBeenCalled();
  });

  it("dispatches a group message when its ClickClack bot handle is mentioned", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({
        requireMention: true,
        botHandle: "blackbird",
      }),
      config: {} satisfies CoreConfig,
      message: createMessage({ body: "@blackbird please help" }),
    });

    const dispatchTurn = vi.mocked(runtime.channel.inbound.dispatch);
    expect(dispatchTurn).toHaveBeenCalledTimes(1);
    expect(dispatchTurn.mock.calls[0]?.[0].ctxPayload.WasMentioned).toBe(true);
  });

  it("does not bypass mention gating for a command mentioning another user", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.channel.commands.shouldComputeCommandAuthorized).mockReturnValue(true);
    vi.mocked(runtime.channel.commands.shouldHandleTextCommands).mockReturnValue(true);
    vi.mocked(runtime.channel.text.hasControlCommand).mockReturnValue(true);
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({
        requireMention: true,
        botHandle: "blackbird",
      }),
      config: {} satisfies CoreConfig,
      message: createMessage({ body: "/status @alice" }),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it.each([
    { body: "@research investigate this", shouldDispatch: true },
    { body: "@service investigate this", shouldDispatch: false },
  ])(
    "evaluates $body against the managed discussion agent before dispatch",
    async ({ body, shouldDispatch }) => {
      const runtime = createRuntime();
      setClickClackRuntime(runtime);
      getClickClackDiscussionBindingStore(runtime).set(
        "agent:research:main",
        createInboundDiscussionBinding({
          externalRef: "openclaw:test:research-mentions",
          label: "Research mentions",
        }),
      );

      const currentConfig = {
        agents: {
          ownership: "explicit",
          entries: {
            research: { groupChat: { mentionPatterns: ["@research"] } },
            "service-bot": { groupChat: { mentionPatterns: ["@service"] } },
          },
        },
        bindings: [
          {
            agentId: "service-bot",
            match: { channel: "clickclack", accountId: "default" },
          },
        ],
        channels: {
          clickclack: {
            enabled: true,
            baseUrl: "http://127.0.0.1:8080",
            token: "test-token-placeholder",
            workspace: "wsp_1",
            discussions: { enabled: true, workspace: "wsp_1" },
          },
        },
      } satisfies CoreConfig;
      vi.mocked(runtime.config.current).mockReturnValue(currentConfig);
      await handleClickClackInbound({
        account: createAgentAccount({
          agentId: "service-bot",
          requireMention: true,
          discussions: { enabled: true, workspace: "wsp_1", section: "Sessions" },
        }),
        config: currentConfig,
        message: createMessage({ body }),
      });

      const dispatch = vi.mocked(runtime.channel.inbound.dispatch);
      expect(dispatch).toHaveBeenCalledTimes(shouldDispatch ? 1 : 0);
      if (shouldDispatch) {
        expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
          route: { agentId: "research" },
          ctxPayload: { WasMentioned: true },
        });
      }
    },
  );
});
