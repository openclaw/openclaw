import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getClickClackDiscussionBindingStore,
  type ClickClackDiscussionBinding,
} from "./discussions/binding-store.js";
import { handleClickClackInbound } from "./inbound.js";
import {
  createInboundRuntime,
  createInboundAgentAccount as createAgentAccount,
  createInboundAuthor as createAuthor,
  createInboundAccountConfig as createAccountConfig,
  publishInboundAccountConfig as publishAccountConfig,
  createInboundMessage as createMessage,
  createInboundDiscussionBinding,
  createInboundDiscussionConfig,
} from "./inbound.test-support.js";
import { setClickClackRuntime } from "./runtime.js";
import type {
  ClickClackAccountConfig,
  ClickClackMessage,
  CoreConfig,
  ResolvedClickClackAccount,
} from "./types.js";

let runtime: PluginRuntime;
beforeEach(() => {
  runtime = createInboundRuntime(false);
  setClickClackRuntime(runtime);
});

describe("ClickClack inbound mention gating", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records attachment persistence failures before dropping inbound delivery", async () => {
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

  it.each<{
    name: string;
    account?: Partial<ResolvedClickClackAccount>;
    message?: Partial<ClickClackMessage>;
    bot?: boolean;
    direct?: boolean;
    allowed: boolean;
  }>([
    { name: "denies bots by default", bot: true, allowed: false },
    {
      name: "accepts legacy messages without author kind",
      message: { author: undefined },
      allowed: true,
    },
    {
      name: "does not apply wildcard group bot policy to DMs",
      bot: true,
      direct: true,
      account: { groups: { "*": { allowBots: "mentions" } } },
      allowed: false,
    },
  ])("$name", async ({ account: overrides, message, bot, direct, allowed }) => {
    const account = createAgentAccount({ allowFrom: ["usr_owner"], ...overrides });
    const config = {} satisfies CoreConfig;
    publishAccountConfig(runtime, account, config);
    await handleClickClackInbound({
      account,
      config,
      message: createMessage({
        body: "hello",
        author: createAuthor({ kind: bot ? "bot" : "human" }),
        ...(direct ? { channel_id: undefined, direct_conversation_id: "dm_1" } : {}),
        ...message,
      }),
    });
    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (!allowed) {
      expect(runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
      expect(runtime.llm.complete).not.toHaveBeenCalled();
    }
  });

  it("does not dispatch ClickClack activity rows as bot prompts", async () => {
    const account = createAgentAccount({ allowFrom: ["usr_sender"], allowBots: true });
    const config = {} satisfies CoreConfig;
    publishAccountConfig(runtime, account, config);

    await handleClickClackInbound({
      account,
      config,
      message: createMessage({
        author_id: "usr_sender",
        kind: "agent_tool",
        author: createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" }),
      }),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(runtime.llm.complete).not.toHaveBeenCalled();
  });

  it("dispatches an allowed bot-authored message through the shared loop guard", async () => {
    const account = createAgentAccount({ allowFrom: ["usr_sender"], allowBots: true });
    const config = {
      channels: { defaults: { botLoopProtection: { maxEventsPerWindow: 7 } } },
    } satisfies CoreConfig;
    publishAccountConfig(runtime, account, config);

    await handleClickClackInbound({
      account,
      config,
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
      nowMs: Date.parse("2026-05-09T12:00:00.000Z"),
      defaultsConfig: { maxEventsPerWindow: 7 },
      defaultEnabled: true,
    });
  });

  it.each<{
    name: string;
    account?: Partial<ResolvedClickClackAccount>;
    message?: Partial<ClickClackMessage>;
    root?: Partial<ClickClackMessage>;
    unavailable?: boolean;
    shouldDispatch: boolean;
  }>([
    {
      name: "preserves mention gating for another bot's thread",
      root: { author_id: "usr_other_bot" },
      shouldDispatch: false,
    },
    {
      name: "rejects a mismatched root message",
      root: { id: "msg_other", thread_root_id: "msg_other" },
      shouldDispatch: false,
    },
    {
      name: "rejects a root from another workspace",
      root: { workspace_id: "wsp_other" },
      shouldDispatch: false,
    },
    {
      name: "rejects a root from another channel",
      root: { channel_id: "chn_other" },
      shouldDispatch: false,
    },
    {
      name: "does not equate a bot reply with owning the thread",
      root: { parent_message_id: "msg_actual_root", thread_root_id: "msg_actual_root" },
      shouldDispatch: false,
    },
    {
      name: "preserves mention gating when root lookup fails",
      unavailable: true,
      shouldDispatch: false,
    },
    {
      name: "preserves the mention-only bot sender policy in this bot's thread",
      account: { allowFrom: ["usr_owner"], allowBots: "mentions" },
      message: { author: createAuthor({ kind: "bot" }) },
      shouldDispatch: false,
    },
    {
      name: "preserves mention gating in the parent channel",
      message: { parent_message_id: undefined, thread_root_id: "msg_1" },
      shouldDispatch: false,
    },
    {
      name: "uses exact channel policy over the wildcard and account",
      account: {
        groups: {
          "*": { requireMentionInBotThreads: false },
          chn_1: { requireMentionInBotThreads: true },
        },
      },
      shouldDispatch: false,
    },
    {
      name: "inherits wildcard thread policy through a partial channel rule",
      account: {
        requireMentionInBotThreads: true,
        groups: {
          "*": { requireMentionInBotThreads: false },
          chn_1: { mentionPatterns: [] },
        },
      },
      shouldDispatch: true,
    },
  ])("$name", async ({ account, message, root, unavailable, shouldDispatch }) => {
    const fetchRoot = vi.fn<typeof fetch>();
    if (unavailable) {
      fetchRoot.mockRejectedValue(new Error("ClickClack unavailable"));
    } else {
      fetchRoot.mockResolvedValue(
        Response.json({
          message: createMessage({
            id: "msg_root",
            thread_root_id: "msg_root",
            author_id: "usr_receiver",
            ...root,
          }),
        }),
      );
    }
    vi.stubGlobal("fetch", fetchRoot);
    const resolvedAccount = createAgentAccount({
      requireMention: true,
      requireMentionInBotThreads: false,
      ...account,
    });
    const config = createAccountConfig(resolvedAccount);
    vi.mocked(runtime.config.current).mockReturnValue(config);

    await handleClickClackInbound({
      account: resolvedAccount,
      config,
      message: createMessage({
        parent_message_id: "msg_root",
        thread_root_id: "msg_root",
        body: "please follow up",
        ...message,
      }),
    });

    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(shouldDispatch ? 1 : 0);
  });

  it.each<{
    name: string;
    patch?: Partial<ClickClackAccountConfig>;
    remove?: boolean;
    removeChannel?: boolean;
    botSender?: boolean;
  }>([
    {
      name: "thread mentions become required",
      patch: { requireMentionInBotThreads: true },
    },
    { name: "sender access is revoked", patch: { allowFrom: ["usr_other"] } },
    { name: "bot senders are disabled", patch: { allowBots: false }, botSender: true },
    { name: "the account is disabled", patch: { enabled: false } },
    { name: "the account is removed", remove: true },
    { name: "the default account's channel is removed", removeChannel: true },
    { name: "the bot identity is reassigned", patch: { botUserId: "usr_other_bot" } },
    { name: "the workspace is reassigned", patch: { workspace: "wsp_other" } },
    { name: "the public server is reassigned", patch: { baseUrl: "http://127.0.0.1:8081" } },
    { name: "the API server is reassigned", patch: { apiBaseUrl: "http://127.0.0.1:8081" } },
  ])(
    "rechecks policy when $name during root lookup",
    async ({ patch, remove, removeChannel, botSender }) => {
      const account = createAgentAccount({
        accountId: removeChannel ? "default" : "work",
        requireMention: true,
        requireMentionInBotThreads: false,
        allowFrom: ["usr_owner"],
        allowBots: true,
        config: { workspace: "wsp_1" },
      });
      const config = createAccountConfig(account);
      vi.mocked(runtime.config.current).mockReturnValue(config);
      const lookupStarted = createDeferred<void>();
      const root = createDeferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(() => {
          lookupStarted.resolve();
          return root.promise;
        }),
      );
      const handling = handleClickClackInbound({
        account,
        config,
        message: createMessage({
          parent_message_id: "msg_root",
          thread_root_id: "msg_root",
          body: "please follow up",
          author: createAuthor({ kind: botSender ? "bot" : "human" }),
        }),
      });
      await lookupStarted.promise;
      vi.mocked(runtime.config.current).mockReturnValue(
        removeChannel
          ? {}
          : {
              channels: {
                clickclack: {
                  accounts: remove
                    ? {}
                    : { work: { ...config.channels?.clickclack?.accounts?.work, ...patch } },
                },
              },
            },
      );
      root.resolve(
        Response.json({
          message: createMessage({
            id: "msg_root",
            thread_root_id: "msg_root",
            author_id: "usr_receiver",
          }),
        }),
      );
      await handling;

      expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each<{
    name: string;
    patch: Partial<ClickClackAccountConfig>;
    body?: string;
    command?: boolean;
    botSender?: boolean;
    senderGroup?: boolean;
    accessGroups?: CoreConfig["accessGroups"];
    omitThreadPolicy?: boolean;
    shouldDispatch: boolean;
  }>([
    { name: "bot identity changes", patch: { botUserId: "usr_other_bot" }, shouldDispatch: false },
    {
      name: "thread mentions become required",
      patch: { requireMentionInBotThreads: true },
      shouldDispatch: false,
    },
    {
      name: "ordinary group sender access is revoked without a thread option",
      patch: { allowFrom: ["usr_other"] },
      omitThreadPolicy: true,
      shouldDispatch: false,
    },
    {
      name: "ordinary group bot access is revoked without a thread option",
      patch: { allowBots: false },
      botSender: true,
      omitThreadPolicy: true,
      shouldDispatch: false,
    },
    {
      name: "static sender group membership is revoked",
      patch: {},
      senderGroup: true,
      accessGroups: {
        operators: { type: "message.senders", members: { clickclack: ["usr_other"] } },
      },
      shouldDispatch: false,
    },
    {
      name: "static sender group is cloned without changing membership",
      patch: {},
      senderGroup: true,
      accessGroups: {
        operators: { type: "message.senders", members: { clickclack: ["usr_owner"] } },
      },
      shouldDispatch: true,
    },
    {
      name: "bot sender now requires a mention",
      patch: { allowBots: "mentions" },
      botSender: true,
      shouldDispatch: false,
    },
    {
      name: "bot sender satisfies its new mention restriction",
      patch: { allowBots: "mentions" },
      body: "@blackbird please follow up",
      botSender: true,
      shouldDispatch: true,
    },
    {
      name: "bot sender is replaced by a human-only wildcard",
      patch: { allowFrom: ["*"] },
      botSender: true,
      shouldDispatch: false,
    },
    {
      name: "an authorized command retains activation",
      patch: { requireMentionInBotThreads: true },
      body: "/status",
      command: true,
      shouldDispatch: true,
    },
  ])(
    "rechecks admission when $name while ingress settles",
    async ({
      patch,
      body,
      command,
      botSender,
      senderGroup,
      accessGroups,
      omitThreadPolicy,
      shouldDispatch,
    }) => {
      if (command) {
        vi.mocked(runtime.channel.commands.shouldComputeCommandAuthorized).mockReturnValue(true);
        vi.mocked(runtime.channel.commands.shouldHandleTextCommands).mockReturnValue(true);
      }
      const account = createAgentAccount({
        requireMention: !omitThreadPolicy,
        requireMentionInBotThreads: omitThreadPolicy ? undefined : false,
        ...(senderGroup ? { allowFrom: ["accessGroup:operators"] } : {}),
        ...(botSender ? { allowBots: true, allowFrom: ["usr_owner"] } : {}),
      });
      const config: CoreConfig = {
        ...createAccountConfig(account),
        ...(senderGroup
          ? {
              accessGroups: {
                operators: { type: "message.senders", members: { clickclack: ["usr_owner"] } },
              },
            }
          : {}),
      };
      vi.mocked(runtime.config.current).mockReturnValue(config);
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
          Response.json({
            message: createMessage({
              id: "msg_root",
              thread_root_id: "msg_root",
              author_id: "usr_receiver",
            }),
          }),
        ),
      );
      const admitted = createDeferred<void>();
      const resume = createDeferred<void>();
      const resolveStable = runtime.channel.inbound.ingress.resolveStable;
      vi.spyOn(runtime.channel.inbound.ingress, "resolveStable").mockImplementation(
        async (params) => {
          const result = await resolveStable(params);
          admitted.resolve();
          await resume.promise;
          return result;
        },
      );
      const handling = handleClickClackInbound({
        account,
        config,
        message: createMessage({
          ...(omitThreadPolicy
            ? {}
            : { parent_message_id: "msg_root", thread_root_id: "msg_root" }),
          body: body ?? "please follow up",
          author: createAuthor({ kind: botSender ? "bot" : "human" }),
        }),
      });
      await admitted.promise;
      vi.mocked(runtime.config.current).mockReturnValue({
        ...config,
        ...(accessGroups ? { accessGroups } : {}),
        channels: {
          clickclack: { ...config.channels?.clickclack, ...patch },
        },
      });
      resume.resolve();
      await handling;

      expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(shouldDispatch ? 1 : 0);
    },
  );

  it("rechecks discussion access after the thread root lookup", async () => {
    getClickClackDiscussionBindingStore(runtime).set(
      "agent:research:main",
      createInboundDiscussionBinding(),
    );
    const discussionConfig = createInboundDiscussionConfig();
    const config: CoreConfig = {
      channels: {
        clickclack: {
          ...discussionConfig.channels?.clickclack,
          requireMention: true,
          requireMentionInBotThreads: false,
        },
      },
    };
    vi.mocked(runtime.config.current).mockReturnValue(config);
    const root = createDeferred<Response>();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockReturnValue(root.promise));

    const handling = handleClickClackInbound({
      account: createAgentAccount({
        requireMention: true,
        requireMentionInBotThreads: false,
        discussions: { enabled: true, workspace: "wsp_1", section: "Sessions" },
      }),
      config,
      message: createMessage({
        parent_message_id: "msg_root",
        thread_root_id: "msg_root",
        body: "please follow up",
      }),
    });

    vi.mocked(runtime.config.current).mockReturnValue({
      channels: {
        clickclack: { ...config.channels?.clickclack, discussions: { enabled: false } },
      },
    });
    root.resolve(
      Response.json({
        message: createMessage({
          id: "msg_root",
          thread_root_id: "msg_root",
          author_id: "usr_receiver",
        }),
      }),
    );
    await handling;

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("evaluates mentions against the managed discussion agent before dispatch", async () => {
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
      message: createMessage({ body: "@research investigate this" }),
    });

    const dispatch = vi.mocked(runtime.channel.inbound.dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      route: { agentId: "research" },
      ctxPayload: { WasMentioned: true },
    });
  });
});
