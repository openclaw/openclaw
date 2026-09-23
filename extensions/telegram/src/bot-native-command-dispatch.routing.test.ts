import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  apiCalls,
  commandMessage,
  createBot,
  from,
  harness,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";

const groupChat = { id: -42001, type: "supergroup", title: "Project", is_forum: true } as const;

describe("registered native command routing through the message pipeline", () => {
  it.each([
    { native: true, text: false, source: "native", kind: "native" },
    { native: false, text: true, source: "text", kind: "text-slash" },
  ])(
    "classifies /status with native=$native and text=$text",
    async ({ native, text, source, kind }) => {
      const bot = createBot(native, text);
      await bot.handleUpdate({ update_id: 1001, message: commandMessage("/status") });
      expect(harness.replySpy).toHaveBeenCalledTimes(1);
      expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
        CommandSource: source,
        CommandTurn: { kind, body: "/status", authorized: true },
        SessionKey: "agent:main:main",
      });
      expect(harness.replySpy.mock.calls[0]?.[0]).not.toHaveProperty("CommandTargetSessionKey");
    },
  );

  it("authorizes paired DMs without marking the sender as an owner", async () => {
    harness.getReadChannelAllowFromStoreMock().mockResolvedValue([String(from.id)]);
    const bot = createBot(true, true, {
      commands: { native: true },
      channels: { telegram: { dmPolicy: "pairing", allowFrom: [], streaming: { mode: "off" } } },
    });

    await bot.handleUpdate({ update_id: 1001, message: commandMessage("/status") });

    expect(harness.replySpy).toHaveBeenCalledOnce();
    const context = harness.replySpy.mock.calls[0]?.[0];
    expect(context).toMatchObject({
      CommandAuthorized: true,
      CommandTurn: { kind: "native", body: "/status", authorized: true },
    });
    expect(context).not.toHaveProperty("OwnerAllowFrom");
  });

  it.each([
    { enabled: false, disableBlockStreaming: true },
    { enabled: true, disableBlockStreaming: false },
  ])(
    "passes nested block streaming enabled=$enabled to native command dispatch",
    async ({ enabled, disableBlockStreaming }) => {
      const bot = createBot(true, true, {
        commands: { native: true },
        channels: {
          telegram: {
            dmPolicy: "open",
            allowFrom: ["*"],
            streaming: { mode: "partial", block: { enabled } },
          },
        },
      });

      await bot.handleUpdate({ update_id: 1001, message: commandMessage("/status") });

      expect(harness.replySpy).toHaveBeenCalledOnce();
      expect(harness.replySpy.mock.calls[0]?.[1]).toMatchObject({ disableBlockStreaming });
    },
  );

  it.each(["/queue Can you diagnose this?", "/think high\nsummarize the thread so far"])(
    "preserves every argument in %s",
    async (text) => {
      const bot = createBot();
      await bot.handleUpdate({ update_id: 1001, message: commandMessage(text) });
      expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
        CommandBody: text,
        CommandTurn: { kind: "native", body: text },
      });
    },
  );

  it.each(["/status", "/new", "/reset"])(
    "routes %s to the topic agent and chat session",
    async (text) => {
      const cfg: OpenClawConfig = {
        commands: { native: true },
        agents: { list: [{ id: "main", default: true }, { id: "topic-agent" }] },
        channels: {
          telegram: {
            groupPolicy: "open",
            groupAllowFrom: ["42001"],
            groups: {
              "-42001": { requireMention: false, topics: { "42": { agentId: "topic-agent" } } },
            },
          },
        },
      };
      const bot = createBot(true, true, cfg);
      await bot.handleUpdate({
        update_id: 1001,
        message: {
          ...commandMessage(text),
          chat: groupChat,
          message_thread_id: 42,
          is_topic_message: true,
        },
      });
      expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
        CommandSource: "native",
        SessionKey: "agent:topic-agent:telegram:group:-42001:topic:42",
        From: "telegram:group:-42001:topic:42",
        ChatType: "group",
        ConversationRoutePeerId: "-42001:topic:42",
        MessageThreadId: 42,
        OriginatingTo: "telegram:-42001:topic:42",
        ThreadParentId: "-42001",
      });
    },
  );

  it.each([
    { name: "forum topic", threadId: 42, conversationId: "-42001:topic:42" },
    { name: "top-level group", threadId: undefined, conversationId: "-42002" },
  ])(
    "routes native commands through a bound $name session",
    async ({ threadId, conversationId }) => {
      const bot = createBot(true, true, {
        commands: { native: true },
        agents: { list: [{ id: "main", default: true }, { id: "bound-agent" }] },
        channels: {
          telegram: {
            groupPolicy: "open",
            groupAllowFrom: [String(from.id)],
            groups: { "*": { requireMention: false } },
            streaming: { mode: "off" },
          },
        },
      });
      const bindingId = `binding:${conversationId}`;
      const sessionKey = `agent:bound-agent:session:${conversationId}`;
      const resolveByConversation = vi.fn<SessionBindingAdapter["resolveByConversation"]>(
        (conversation) =>
          conversation.conversationId === conversationId
            ? {
                bindingId,
                targetSessionKey: sessionKey,
                targetKind: "session",
                conversation,
                status: "active",
                boundAt: 1,
              }
            : null,
      );
      const touch = vi.fn<NonNullable<SessionBindingAdapter["touch"]>>();
      const adapter: SessionBindingAdapter = {
        channel: "telegram",
        accountId: "default",
        listBySession: () => [],
        resolveByConversation,
        touch,
      };
      registerSessionBindingAdapter(adapter);
      try {
        await bot.handleUpdate({
          update_id: 1001,
          message: {
            ...commandMessage("/status"),
            chat:
              threadId !== undefined ? groupChat : { id: -42002, type: "group", title: "Project" },
            ...(threadId !== undefined
              ? { message_thread_id: threadId, is_topic_message: true as const }
              : {}),
          },
        });

        expect(resolveByConversation).toHaveBeenCalledWith({
          channel: "telegram",
          accountId: "default",
          conversationId,
        });
        expect(touch).toHaveBeenCalledWith(bindingId, undefined);
        expect(harness.replySpy).toHaveBeenCalledOnce();
        expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
          CommandSource: "native",
          SessionKey: sessionKey,
          OriginatingTo: `telegram:${conversationId}`,
          ConversationRoutePeerId: conversationId,
        });
      } finally {
        unregisterSessionBindingAdapter({ channel: "telegram", accountId: "default", adapter });
      }
    },
  );

  it("treats an authorized native command as a mention even with unsupported arguments", async () => {
    const bot = createBot(true, true, {
      commands: { native: true },
      channels: {
        telegram: {
          groupPolicy: "open",
          groupAllowFrom: [String(from.id)],
          groups: { "*": { requireMention: true } },
        },
      },
    });
    await bot.handleUpdate({
      update_id: 1001,
      message: { ...commandMessage("/stop later"), chat: groupChat },
    });
    expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
      CommandSource: "native",
      CommandBody: "/stop later",
      WasMentioned: true,
    });
  });

  it("silently blocks unauthorized /new in an unbound forum topic", async () => {
    const bot = createBot(true, true, {
      commands: { native: true },
      channels: {
        telegram: {
          groupPolicy: "open",
          groupAllowFrom: ["99999"],
          groups: { "*": { requireMention: false } },
        },
      },
    });

    await bot.handleUpdate({
      update_id: 1001,
      message: {
        ...commandMessage("/new"),
        chat: groupChat,
        message_thread_id: 42,
        is_topic_message: true,
      },
    });

    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(apiCalls.mock.calls.filter(([method]) => method === "sendMessage")).toEqual([]);
  });

  it("uses the current config snapshot after startup", async () => {
    const bot = createBot();
    const runtimeCfg: OpenClawConfig = {
      commands: { native: true },
      agents: { list: [{ id: "changed-agent", default: true }] },
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    };
    harness.getLoadConfigMock().mockReturnValue(runtimeCfg);
    await bot.handleUpdate({ update_id: 1001, message: commandMessage("/status") });
    expect(harness.dispatchReplyWithBufferedBlockDispatcher.mock.calls[0]?.[0].cfg).toBe(
      runtimeCfg,
    );
    expect(harness.replySpy.mock.calls[0]?.[0].SessionKey).toContain("agent:changed-agent:");
  });

  it("does not dispatch the same update twice", async () => {
    const bot = createBot();
    const update = { update_id: 1001, message: commandMessage("/status") };
    await bot.handleUpdate(update);
    await bot.handleUpdate(update);
    expect(harness.replySpy).toHaveBeenCalledTimes(1);
  });
});
