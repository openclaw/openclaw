import "./discussions/session-authority.test-support.js";
import {
  hasControlCommand,
  shouldComputeCommandAuthorized,
} from "openclaw/plugin-sdk/command-detection";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getClickClackDiscussionBindingStore,
  type ClickClackDiscussionBinding,
} from "./discussions/binding-store.js";
import { handleClickClackInbound } from "./inbound.js";
import {
  createInboundRuntime,
  createInboundAgentAccount as makeAccount,
  createInboundAuthor as author,
  createInboundAccountConfig as accountConfig,
  publishInboundAccountConfig as publishAccountConfig,
  createInboundMessage as createMessage,
  createInboundDiscussionBinding,
  createInboundDiscussionConfig,
} from "./inbound.test-support.js";
import { setClickClackRuntime } from "./runtime.js";
import type {
  ClickClackAccountConfig,
  ClickClackMessage as Message,
  CoreConfig,
  ResolvedClickClackAccount as Account,
} from "./types.js";

let runtime: PluginRuntime;
beforeEach(() => {
  runtime = createInboundRuntime(false);
  vi.mocked(runtime.channel.text.hasControlCommand).mockImplementation(hasControlCommand);
  setClickClackRuntime(runtime);
});

function threadAccount(patch: Partial<Account> = {}) {
  return makeAccount({
    requireMention: true,
    requireMentionInBotThreads: false,
    ...patch,
  });
}
function threadMessage(patch: Partial<Message> = {}) {
  return createMessage({
    parent_message_id: "msg_root",
    thread_root_id: "msg_root",
    body: "please follow up",
    ...patch,
  });
}
function discussionAccount(patch: Partial<Account> = {}) {
  return makeAccount({
    discussions: { enabled: true, workspace: "wsp_1", section: "Sessions" },
    ...patch,
  });
}
async function bindDiscussion(patch: Partial<ClickClackDiscussionBinding> = {}) {
  await getClickClackDiscussionBindingStore(runtime).setIfCurrent(
    "agent:research:main",
    undefined,
    createInboundDiscussionBinding(patch),
  );
}

function rootResponse(patch: Partial<Message> = {}) {
  return Response.json({
    message: createMessage({
      id: "msg_root",
      thread_root_id: "msg_root",
      author_id: "usr_receiver",
      ...patch,
    }),
  });
}

function scenario<T extends object>(name: string, options: T, shouldDispatch = false) {
  return { name, shouldDispatch, ...options };
}

function senderGroups(member: string) {
  return { operators: { type: "message.senders" as const, members: { clickclack: [member] } } };
}

async function dispatchPublished(
  account: Account,
  message: Partial<Message>,
  config: CoreConfig = {},
) {
  publishAccountConfig(runtime, account, config);
  await handleClickClackInbound({ account, config, message: createMessage(message) });
}
function handleCurrent(
  account: Account,
  message: Partial<Message>,
  config: CoreConfig = accountConfig(account),
) {
  vi.mocked(runtime.config.current).mockReturnValue(config);
  return handleClickClackInbound({ account, config, message: createMessage(message) });
}

describe("ClickClack inbound mention gating", () => {
  it.each([
    { body: "! poll", allowed: false },
    { body: "hello ! poll", allowed: false },
    { body: "@blackbird ! poll", allowed: true },
    { body: "/bash poll", allowed: true },
  ])(
    "keeps command authorization separate from mention bypass: $body",
    async ({ body, allowed }) => {
      vi.mocked(runtime.channel.commands.shouldComputeCommandAuthorized).mockImplementation(
        shouldComputeCommandAuthorized,
      );
      vi.mocked(runtime.channel.commands.shouldHandleTextCommands).mockReturnValue(true);
      await dispatchPublished(
        makeAccount({ requireMention: true, allowFrom: ["usr_owner"] }),
        { body },
        { commands: { bash: true } },
      );
      const dispatch = vi.mocked(runtime.channel.inbound.dispatch);
      expect(dispatch).toHaveBeenCalledTimes(allowed ? 1 : 0);
      if (allowed) {
        expect(dispatch.mock.calls[0]?.[0].ctxPayload.CommandAuthorized).toBe(true);
      }
    },
  );

  it.each([
    { name: "direct message", body: "hello", direct: true, allowed: true },
    { name: "empty group body", body: "", allowed: false },
    {
      name: "email address is not a handle mention",
      body: "email alice@example.com",
      botHandle: "example",
      allowed: false,
    },
    {
      name: "plain display name is not a mention",
      body: "Blackbird can you help?",
      allowed: false,
    },
    {
      name: "one matching local pattern",
      body: "@secondbot please",
      mentionPatterns: ["@firstbot", "@secondbot"],
      allowed: true,
    },
    {
      name: "unsafe local pattern",
      body: `${"a".repeat(20_000)}!`,
      mentionPatterns: ["(a+)+$"],
      allowed: false,
    },
    {
      name: "unsafe shared pattern",
      body: `${"a".repeat(20_000)}!`,
      sharedPatterns: ["(a+)+$"],
      allowed: false,
    },
  ])("mention recognition through inbound dispatch: $name", async (sample) => {
    const account = makeAccount({
      requireMention: true,
      mentionPatterns: sample.mentionPatterns ?? [],
      ...(sample.botHandle ? { botHandle: sample.botHandle } : {}),
    });
    await dispatchPublished(
      account,
      {
        body: sample.body,
        ...(sample.direct ? { channel_id: undefined, direct_conversation_id: "dm_1" } : {}),
      },
      { messages: { groupChat: { mentionPatterns: sample.sharedPatterns ?? [] } } },
    );
    const dispatch = vi.mocked(runtime.channel.inbound.dispatch);
    expect(dispatch).toHaveBeenCalledTimes(sample.allowed ? 1 : 0);
    if (sample.allowed) {
      expect(dispatch.mock.calls[0]?.[0].ctxPayload.WasMentioned).toBe(!sample.direct);
    }
  });

  it("records attachment persistence failures before dropping inbound delivery", async () => {
    const mainSessionKey = "agent:research:main";
    const bindingStore = getClickClackDiscussionBindingStore(runtime);
    await bindDiscussion({ sessionId: "old-session-id" });
    const persisted = runtime.state.openSyncKeyedStore<ClickClackDiscussionBinding>({
      namespace: "discussion-bindings",
      maxEntries: 10_000,
      overflowPolicy: "reject-new",
    });
    persisted.register = vi.fn(() => {
      throw new Error("SQLITE_FULL");
    });

    const currentConfig = createInboundDiscussionConfig() satisfies CoreConfig;
    await handleCurrent(
      discussionAccount({ replyMode: "model" }),
      { body: "Old discussion" },
      currentConfig,
    );

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(bindingStore.get(mainSessionKey)).toMatchObject({ sessionId: "old-session-id" });
    const children = vi.mocked(runtime.logging.getChildLogger).mock;
    const loggerCall = children.calls.findIndex(
      ([context]) => context?.plugin === "clickclack" && context.feature === "discussions",
    );
    const logger = children.results[loggerCall]?.value;
    expect(logger?.warn).toHaveBeenCalledWith(
      "discussion attachment refresh failed for channel chn_1: Error: SQLITE_FULL",
    );
  });

  it.each<{
    name: string;
    account?: Partial<Account>;
    message?: Partial<Message>;
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
  ])("$name", async ({ account: patch, message, bot, direct, allowed }) => {
    const account = makeAccount({ allowFrom: ["usr_owner"], ...patch });
    await dispatchPublished(account, {
      body: "hello",
      author: author({ kind: bot ? "bot" : "human" }),
      ...(direct ? { channel_id: undefined, direct_conversation_id: "dm_1" } : {}),
      ...message,
    });
    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (!allowed) {
      expect(runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
      expect(runtime.llm.complete).not.toHaveBeenCalled();
    }
  });

  it("does not dispatch ClickClack activity rows as bot prompts", async () => {
    const account = makeAccount({ allowFrom: ["usr_sender"], allowBots: true });
    await dispatchPublished(account, {
      author_id: "usr_sender",
      kind: "agent_tool",
      author: author({ id: "usr_sender", kind: "bot", handle: "sender" }),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(runtime.llm.complete).not.toHaveBeenCalled();
  });

  it.each([
    { name: "channel", message: {}, conversationId: "chn_1" },
    {
      name: "first channel thread",
      message: { parent_message_id: "msg_root_a", thread_root_id: "msg_root_a" },
      conversationId: "msg_root_a",
    },
    {
      name: "second channel thread",
      message: { parent_message_id: "msg_root_b", thread_root_id: "msg_root_b" },
      conversationId: "msg_root_b",
    },
    {
      name: "direct conversation",
      message: { channel_id: undefined, direct_conversation_id: "dcn_1" },
      conversationId: "dcn_1",
    },
    {
      name: "direct thread",
      message: {
        channel_id: undefined,
        direct_conversation_id: "dcn_1",
        parent_message_id: "msg_direct_root",
        thread_root_id: "msg_direct_root",
      },
      conversationId: "msg_direct_root",
    },
  ])(
    "dispatches an allowed bot in a $name through its loop scope",
    async ({ message, conversationId }) => {
      const account = makeAccount({ allowFrom: ["usr_sender"], allowBots: true });
      const config = {
        channels: { defaults: { botLoopProtection: { maxEventsPerWindow: 7 } } },
      } satisfies CoreConfig;
      await dispatchPublished(
        account,
        {
          author_id: "usr_sender",
          author: author({ id: "usr_sender", kind: "bot", handle: "sender" }),
          ...message,
        },
        config,
      );

      const dispatch = vi.mocked(runtime.channel.inbound.dispatch);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0]?.[0].botLoopProtection).toMatchObject({
        scopeId: "wsp_1",
        conversationId,
        senderId: "usr_sender",
        receiverId: "usr_receiver",
        eventId: "msg_1",
        nowMs: Date.parse("2026-05-09T12:00:00.000Z"),
        defaultsConfig: { maxEventsPerWindow: 7 },
        defaultEnabled: true,
      });
    },
  );

  it.each<{
    name: string;
    account?: Partial<Account>;
    message?: Partial<Message>;
    root?: Partial<Message>;
    unavailable?: boolean;
    shouldDispatch: boolean;
  }>([
    scenario("another bot's thread", { root: { author_id: "usr_other_bot" } }),
    scenario("mismatched root IDs", { root: { id: "msg_other", thread_root_id: "msg_other" } }),
    scenario("cross-workspace root", { root: { workspace_id: "wsp_other" } }),
    scenario("cross-channel root", { root: { channel_id: "chn_other" } }),
    scenario("bot reply is not the root", {
      root: { parent_message_id: "msg_actual_root", thread_root_id: "msg_actual_root" },
    }),
    scenario("failed root lookup", { unavailable: true }),
    scenario("bot still needs mention", {
      account: { allowFrom: ["usr_owner"], allowBots: "mentions" },
      message: { author: author({ kind: "bot" }) },
    }),
    scenario("parent channel", {
      message: { parent_message_id: undefined, thread_root_id: "msg_1" },
    }),
    scenario("exact policy overrides wildcard", {
      account: {
        groups: {
          "*": { requireMentionInBotThreads: false },
          chn_1: { requireMentionInBotThreads: true },
        },
      },
    }),
    scenario(
      "partial rules inherit wildcard",
      {
        account: {
          requireMentionInBotThreads: true,
          groups: { "*": { requireMentionInBotThreads: false }, chn_1: { mentionPatterns: [] } },
        },
      },
      true,
    ),
  ])(
    "thread mention gating: $name",
    async ({ account, message, root, unavailable, shouldDispatch }) => {
      const fetchRoot = vi.fn<typeof fetch>();
      if (unavailable) {
        fetchRoot.mockRejectedValue(new Error("ClickClack unavailable"));
      } else {
        fetchRoot.mockResolvedValue(rootResponse(root));
      }
      vi.stubGlobal("fetch", fetchRoot);
      const resolvedAccount = threadAccount(account);
      await handleCurrent(resolvedAccount, threadMessage(message));

      expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(shouldDispatch ? 1 : 0);
    },
  );

  it.each<{
    name: string;
    patch?: Partial<ClickClackAccountConfig>;
    remove?: boolean;
    removeChannel?: boolean;
    botSender?: boolean;
  }>([
    { name: "thread mentions become required", patch: { requireMentionInBotThreads: true } },
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
      const account = threadAccount({
        accountId: removeChannel ? "default" : "work",
        allowFrom: ["usr_owner"],
        allowBots: true,
      });
      const config = accountConfig(account);
      const lookupStarted = createDeferred<void>();
      const root = createDeferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(() => {
          lookupStarted.resolve();
          return root.promise;
        }),
      );
      const handling = handleCurrent(
        account,
        threadMessage({ author: author({ kind: botSender ? "bot" : "human" }) }),
        config,
      );
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
      root.resolve(rootResponse());
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
    scenario("bot identity changed", { patch: { botUserId: "usr_other_bot" } }),
    scenario("mentions required", { patch: { requireMentionInBotThreads: true } }),
    scenario("sender revoked, no thread policy", {
      patch: { allowFrom: ["usr_other"] },
      omitThreadPolicy: true,
    }),
    scenario("bot revoked, no thread policy", {
      patch: { allowBots: false },
      botSender: true,
      omitThreadPolicy: true,
    }),
    scenario("sender group revoked", {
      patch: {},
      senderGroup: true,
      accessGroups: senderGroups("usr_other"),
    }),
    scenario(
      "sender group cloned",
      {
        patch: {},
        senderGroup: true,
        accessGroups: senderGroups("usr_owner"),
      },
      true,
    ),
    scenario("bot needs mention", { patch: { allowBots: "mentions" }, botSender: true }),
    scenario(
      "bot mentioned",
      {
        patch: { allowBots: "mentions" },
        body: "@blackbird please follow up",
        botSender: true,
      },
      true,
    ),
    scenario("human-only wildcard", { patch: { allowFrom: ["*"] }, botSender: true }),
    scenario(
      "authorized command",
      {
        patch: { requireMentionInBotThreads: true },
        body: "/status",
        command: true,
      },
      true,
    ),
    scenario("spaced bash still needs a mention", {
      patch: { requireMentionInBotThreads: true },
      body: "! poll",
      command: true,
    }),
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
      const account = makeAccount({
        requireMention: !omitThreadPolicy,
        requireMentionInBotThreads: omitThreadPolicy ? undefined : false,
        ...(senderGroup ? { allowFrom: ["accessGroup:operators"] } : {}),
        ...(botSender ? { allowBots: true, allowFrom: ["usr_owner"] } : {}),
      });
      const config: CoreConfig = {
        ...accountConfig(account),
        ...(senderGroup ? { accessGroups: senderGroups("usr_owner") } : {}),
      };
      vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(rootResponse()));
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
      const handling = handleCurrent(
        account,
        {
          ...(omitThreadPolicy
            ? {}
            : { parent_message_id: "msg_root", thread_root_id: "msg_root" }),
          body: body ?? "please follow up",
          author: author({ kind: botSender ? "bot" : "human" }),
        },
        config,
      );
      await admitted.promise;
      vi.mocked(runtime.config.current).mockReturnValue({
        ...config,
        ...(accessGroups ? { accessGroups } : {}),
        channels: { clickclack: { ...config.channels?.clickclack, ...patch } },
      });
      resume.resolve();
      await handling;

      expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(shouldDispatch ? 1 : 0);
    },
  );

  it("rechecks discussion access after the thread root lookup", async () => {
    await bindDiscussion();
    const account = discussionAccount({ requireMention: true, requireMentionInBotThreads: false });
    const config = accountConfig(account);
    const root = createDeferred<Response>();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockReturnValue(root.promise));

    const handling = handleCurrent(account, threadMessage(), config);

    vi.mocked(runtime.config.current).mockReturnValue({
      channels: {
        clickclack: { ...config.channels?.clickclack, discussions: { enabled: false } },
      },
    });
    root.resolve(rootResponse());
    await handling;

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("evaluates mentions against the managed discussion agent before dispatch", async () => {
    await bindDiscussion();

    const currentConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          research: { groupChat: { mentionPatterns: ["@research"] } },
          "service-bot": { groupChat: { mentionPatterns: ["@service"] } },
        },
      },
      bindings: [
        { agentId: "service-bot", match: { channel: "clickclack", accountId: "default" } },
      ],
      ...createInboundDiscussionConfig(),
    } satisfies CoreConfig;
    await handleCurrent(
      discussionAccount({ agentId: "service-bot", requireMention: true }),
      { body: "@research investigate this" },
      currentConfig,
    );

    const dispatch = vi.mocked(runtime.channel.inbound.dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      route: { agentId: "research" },
      ctxPayload: { WasMentioned: true },
    });
  });
});
