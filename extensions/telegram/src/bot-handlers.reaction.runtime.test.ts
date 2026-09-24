// Telegram tests cover forum reaction topic recovery before authorization and routing.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/session-binding-runtime";
import {
  enqueueRoutedSystemEvent as enqueueActualSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "openclaw/plugin-sdk/system-event-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultTelegramBotDeps } from "./bot-deps.js";
import { createTelegramEventBindings } from "./bot-handlers.event-bindings.js";
import { createTelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import { createTelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import { setTelegramRuntime } from "./runtime.js";
import type { TelegramThreadSpec } from "./thread-spec.js";

const FIRE_EMOJI = "\u{1F525}";
const FORUM_CHAT_ID = -1005678;
const FORUM_TOPIC_ID = 77;
const REACTED_MESSAGE_ID = 100;

type ReactionHandler = (ctx: Record<string, unknown>) => Promise<void>;

const enqueueRoutedSystemEvent = vi.fn();
const runtimeLog = vi.fn();
const runtimeError = vi.fn();
const resolveCachedMessageThreadSpec = vi.fn<
  (params: {
    chatId: number | string;
    messageId: number | string;
  }) => Promise<TelegramThreadSpec | undefined>
>(async () => undefined);

function buildTelegramConfig(overrides?: {
  reactionNotifications?: "all" | "own";
  topics?: Record<string, { enabled?: boolean; agentId?: string }>;
}): OpenClawConfig {
  return {
    channels: {
      telegram: {
        dmPolicy: "open",
        allowFrom: ["*"],
        reactionNotifications: overrides?.reactionNotifications ?? "all",
        groupPolicy: "open",
        groups: {
          [String(FORUM_CHAT_ID)]: {
            enabled: true,
            ...(overrides?.topics ? { topics: overrides.topics } : {}),
          },
        },
      },
    },
  } as OpenClawConfig;
}

/**
 * Registers the real reaction handler against the real authorization runtime so
 * the test proves topic-scoped config lookup, not just the handler's own branch.
 */
function registerHandler(
  cfg: OpenClawConfig,
  wasSentByBot: () => boolean | Promise<boolean> = () => true,
): ReactionHandler {
  const handlers = new Map<string, ReactionHandler>();
  const params: RegisterTelegramHandlerParams = {
    accountId: "default",
    ownerAgentId: "main",
    bot: {
      on: (name: string, handler: ReactionHandler) => {
        handlers.set(name, handler);
      },
    } as RegisterTelegramHandlerParams["bot"],
    cfg,
    mediaMaxBytes: 1,
    opts: { token: "tok" },
    telegramCfg: {},
    logger: getChildLogger({ module: "telegram/reaction-test" }),
    runtime: { log: runtimeLog, error: runtimeError, exit: vi.fn() },
    shouldSkipUpdate: () => false,
    resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
    resolveGroupActivation: () => undefined,
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig: (
      chatId: string | number,
      messageThreadId: number | undefined,
      config: OpenClawConfig,
    ) => resolveTelegramScopedGroupConfig(config.channels?.telegram ?? {}, chatId, messageThreadId),
    processMessage: vi.fn<RegisterTelegramHandlerParams["processMessage"]>(),
    telegramDeps: {
      ...defaultTelegramBotDeps,
      getRuntimeConfig: () => cfg,
      wasSentByBot,
      enqueueRoutedSystemEvent,
      readChannelAllowFromStore: async () => [],
    },
  };

  createTelegramEventBindings({
    params,
    message: {
      ...createTelegramMessagePipeline(params),
      resolveCachedMessageThreadSpec,
    },
    authorization: createTelegramHandlerAuthorization(params),
    registerMessages: () => {},
  }).registerReaction();
  const handler = handlers.get("message_reaction");
  if (!handler) {
    throw new Error("expected message_reaction handler");
  }
  return handler;
}

function forumReactionContext(overrides?: {
  oldReaction?: Array<{ type: string; emoji: string }>;
  newReaction?: Array<{ type: string; emoji: string }>;
  isForum?: boolean;
  isDirectMessages?: boolean;
  chatType?: string;
}) {
  return {
    update: { update_id: 900 },
    messageReaction: {
      chat: {
        id: overrides?.chatType === "private" ? 5678 : FORUM_CHAT_ID,
        type: overrides?.chatType ?? "supergroup",
        ...(overrides?.isForum === false ? {} : { is_forum: true }),
        ...(overrides?.isDirectMessages ? { is_direct_messages: true } : {}),
      },
      message_id: REACTED_MESSAGE_ID,
      user: { id: 10, first_name: "Bob", username: "bob_user" },
      date: 1736380800,
      old_reaction: overrides?.oldReaction ?? [],
      new_reaction: overrides?.newReaction ?? [{ type: "emoji", emoji: FIRE_EMOJI }],
    },
  };
}

function systemEventOptions(): { sessionKey?: string; contextKey?: string } {
  return (enqueueRoutedSystemEvent.mock.calls[0]?.[1] ?? {}) as {
    sessionKey?: string;
    contextKey?: string;
  };
}

describe("registerTelegramReactionHandler forum topic recovery", () => {
  beforeEach(() => {
    setTelegramRuntime(createPluginRuntimeMock());
    resetSystemEventsForTest();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    enqueueRoutedSystemEvent.mockReset();
    runtimeLog.mockClear();
    runtimeError.mockClear();
    resolveCachedMessageThreadSpec.mockReset();
    resolveCachedMessageThreadSpec.mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetSystemEventsForTest();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    clearRuntimeConfigSnapshot();
  });

  it.each(["private", "supergroup"] as const)(
    "authorizes %s reaction senders before queueing distinct additions",
    async (chatType) => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: {
            dmPolicy: "allowlist",
            allowFrom: ["10"],
            groupPolicy: "allowlist",
            groupAllowFrom: ["10"],
            reactionNotifications: "all",
          },
        },
      };
      enqueueRoutedSystemEvent.mockImplementation(enqueueActualSystemEvent);
      const handler = registerHandler(cfg);
      const context = forumReactionContext({ isForum: false, chatType });
      const sessionKey =
        chatType === "private" ? "agent:main:main" : "agent:main:telegram:group:-1005678";
      await handler({
        ...context,
        messageReaction: { ...context.messageReaction, user: { id: 11, first_name: "Denied" } },
      });
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      await handler({
        ...context,
        messageReaction: {
          ...context.messageReaction,
          old_reaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
          new_reaction: [
            { type: "emoji", emoji: FIRE_EMOJI },
            { type: "emoji", emoji: "\u{1F44D}" },
            { type: "emoji", emoji: "\u{1F389}" },
          ],
        },
      });
      expect(peekSystemEventEntries(sessionKey)).toEqual([
        expect.objectContaining({
          text: "Telegram reaction added: \u{1F44D} by Bob (@bob_user) on msg 100",
          contextKey:
            chatType === "private"
              ? "telegram:reaction:add:5678:100:10:\u{1F44D}"
              : "telegram:reaction:add:-1005678:100:10:\u{1F44D}",
        }),
        expect.objectContaining({
          text: "Telegram reaction added: \u{1F389} by Bob (@bob_user) on msg 100",
          contextKey:
            chatType === "private"
              ? "telegram:reaction:add:5678:100:10:\u{1F389}"
              : "telegram:reaction:add:-1005678:100:10:\u{1F389}",
        }),
      ]);
    },
  );

  it("keeps default own, off, and all notification modes distinct", async () => {
    enqueueRoutedSystemEvent.mockImplementation(enqueueActualSystemEvent);
    const cfg: OpenClawConfig = {
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    };
    const context = forumReactionContext({ isForum: false, chatType: "private" });
    await registerHandler(cfg, () => false)(context);
    expect(peekSystemEventEntries("agent:main:main")).toEqual([]);
    await registerHandler(cfg, () => true)(context);
    expect(peekSystemEventEntries("agent:main:main")).toEqual([
      expect.objectContaining({
        text: "Telegram reaction added: \u{1F525} by Bob (@bob_user) on msg 100",
      }),
    ]);
    resetSystemEventsForTest();
    cfg.channels!.telegram!.reactionNotifications = "off";
    await registerHandler(cfg, () => true)(context);
    expect(peekSystemEventEntries("agent:main:main")).toEqual([]);
    cfg.channels!.telegram!.reactionNotifications = "all";
    await registerHandler(cfg, () => false)(context);
    expect(peekSystemEventEntries("agent:main:main")).toEqual([
      expect.objectContaining({
        text: "Telegram reaction added: \u{1F525} by Bob (@bob_user) on msg 100",
      }),
    ]);
  });

  it("does not queue bot actors, unchanged reactions, or removals", async () => {
    enqueueRoutedSystemEvent.mockImplementation(enqueueActualSystemEvent);
    const handler = registerHandler(buildTelegramConfig());
    const context = forumReactionContext({ isForum: false, chatType: "private" });
    await handler({
      ...context,
      messageReaction: {
        ...context.messageReaction,
        user: { id: 10, first_name: "Bot", is_bot: true },
      },
    });
    for (const newReaction of [[{ type: "emoji", emoji: FIRE_EMOJI }], []]) {
      await handler(
        forumReactionContext({
          isForum: false,
          chatType: "private",
          oldReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
          newReaction,
        }),
      );
    }
    expect(peekSystemEventEntries("agent:main:main")).toEqual([]);
  });

  it("keeps a reaction on the runtime-bound global owner's queue", async () => {
    const cfg = {
      ...buildTelegramConfig(),
      agents: { list: [{ id: "main", default: true }, { id: "research" }] },
    };
    setRuntimeConfigSnapshot(cfg);
    const binding = {
      bindingId: "reaction-owner",
      targetSessionKey: "global",
      targetKind: "session" as const,
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: String(FORUM_CHAT_ID),
      },
      status: "active" as const,
      boundAt: 1,
      metadata: { agentId: "research" },
    };
    registerSessionBindingAdapter({
      ...binding.conversation,
      listBySession: () => [binding],
      resolveByConversation: () => binding,
    });
    enqueueRoutedSystemEvent.mockImplementation(enqueueActualSystemEvent);

    await registerHandler(cfg)(forumReactionContext({ isForum: false }));

    expect(peekSystemEventEntries("agent:research:global")).toEqual([
      expect.objectContaining({
        text: `Telegram reaction added: ${FIRE_EMOJI} by Bob (@bob_user) on msg 100`,
      }),
    ]);
    expect(peekSystemEventEntries("agent:main:global")).toEqual([]);
  });

  it("recovers the cached topic before authorization and routes to that topic", async () => {
    resolveCachedMessageThreadSpec.mockResolvedValue({ scope: "forum", id: FORUM_TOPIC_ID });
    const handler = registerHandler(
      buildTelegramConfig({ topics: { [String(FORUM_TOPIC_ID)]: { enabled: true } } }),
    );

    await handler(forumReactionContext());

    expect(resolveCachedMessageThreadSpec).toHaveBeenCalledWith({
      chatId: FORUM_CHAT_ID,
      messageId: REACTED_MESSAGE_ID,
    });
    expect(enqueueRoutedSystemEvent).toHaveBeenCalledTimes(1);
    expect(String(systemEventOptions().sessionKey)).toContain(
      `telegram:group:${FORUM_CHAT_ID}:topic:${FORUM_TOPIC_ID}`,
    );
  });

  it("routes a recovered topic through its configured topic agent", async () => {
    resolveCachedMessageThreadSpec.mockResolvedValue({ scope: "forum", id: FORUM_TOPIC_ID });
    const handler = registerHandler(
      buildTelegramConfig({
        topics: { [String(FORUM_TOPIC_ID)]: { enabled: true, agentId: "topicbot" } },
      }),
    );

    await handler(forumReactionContext());

    expect(enqueueRoutedSystemEvent).toHaveBeenCalledTimes(1);
    expect(String(systemEventOptions().sessionKey)).toContain("topicbot");
  });

  it("applies the recovered topic's disabled config instead of the General topic's", async () => {
    resolveCachedMessageThreadSpec.mockResolvedValue({ scope: "forum", id: FORUM_TOPIC_ID });
    const handler = registerHandler(
      buildTelegramConfig({
        topics: { "1": { enabled: true }, [String(FORUM_TOPIC_ID)]: { enabled: false } },
      }),
    );

    await handler(forumReactionContext());

    expect(enqueueRoutedSystemEvent).not.toHaveBeenCalled();
  });

  it("drops a forum reaction with an unknown topic instead of guessing General", async () => {
    resolveCachedMessageThreadSpec.mockResolvedValue(undefined);
    const handler = registerHandler(buildTelegramConfig({ topics: { "1": { enabled: true } } }));

    await handler(forumReactionContext());

    expect(enqueueRoutedSystemEvent).not.toHaveBeenCalled();
    expect(runtimeLog).toHaveBeenCalledTimes(1);
    const logged = String(runtimeLog.mock.calls[0]?.[0] ?? "");
    expect(logged).toContain("thread-context-unavailable");
    expect(logged).toContain(`chat=${FORUM_CHAT_ID}`);
    expect(logged).toContain(`message=${REACTED_MESSAGE_ID}`);
    // Bounded degradation: route ids only, never message content or display names.
    expect(logged).not.toContain("bob_user");
    expect(logged).not.toContain(FIRE_EMOJI);
  });

  it("routes channel Direct Messages reactions through topic config and agent", async () => {
    resolveCachedMessageThreadSpec.mockResolvedValue({
      scope: "direct-messages",
      id: FORUM_TOPIC_ID,
    });
    const handler = registerHandler(
      buildTelegramConfig({
        topics: { [String(FORUM_TOPIC_ID)]: { enabled: true, agentId: "direct-topic-agent" } },
      }),
    );

    await handler(forumReactionContext({ isForum: false, isDirectMessages: true }));

    expect(enqueueRoutedSystemEvent).toHaveBeenCalledTimes(1);
    expect(String(systemEventOptions().sessionKey)).toContain("direct-topic-agent");
    expect(String(systemEventOptions().sessionKey)).toContain(
      `telegram:group:${FORUM_CHAT_ID}:direct-topic:${FORUM_TOPIC_ID}`,
    );
  });

  it.each([
    { name: "cache miss", recovered: undefined },
    { name: "scope mismatch", recovered: { scope: "forum" as const, id: FORUM_TOPIC_ID } },
  ])("drops a channel Direct Messages reaction on $name", async ({ recovered }) => {
    resolveCachedMessageThreadSpec.mockResolvedValue(recovered);
    const handler = registerHandler(buildTelegramConfig());

    await handler(forumReactionContext({ isForum: false, isDirectMessages: true }));

    expect(enqueueRoutedSystemEvent).not.toHaveBeenCalled();
    expect(runtimeLog).toHaveBeenCalledTimes(1);
    expect(String(runtimeLog.mock.calls[0]?.[0])).toContain("thread-context-unavailable");
  });

  it.each([false, true])(
    "awaits own-message lookup before reaction delivery: %s",
    async (sentByBot) => {
      const lookup = createDeferred<boolean>();
      const cfg = buildTelegramConfig({ reactionNotifications: "own" });
      const handler = registerHandler(cfg, () => lookup.promise);
      const delivery = handler(forumReactionContext({ isForum: false }));
      try {
        await Promise.resolve();
        expect(enqueueRoutedSystemEvent).not.toHaveBeenCalled();
      } finally {
        lookup.resolve(sentByBot);
        await delivery;
      }
      expect(enqueueRoutedSystemEvent).toHaveBeenCalledTimes(sentByBot ? 1 : 0);
    },
  );

  it("never consults the message cache for non-forum groups", async () => {
    const handler = registerHandler(buildTelegramConfig());

    await handler(forumReactionContext({ isForum: false }));

    expect(resolveCachedMessageThreadSpec).not.toHaveBeenCalled();
    expect(enqueueRoutedSystemEvent).toHaveBeenCalledTimes(1);
    expect(String(systemEventOptions().sessionKey)).not.toContain(":topic:");
  });

  it("never consults the message cache for direct chats", async () => {
    const handler = registerHandler(buildTelegramConfig());

    await handler(forumReactionContext({ isForum: false, chatType: "private" }));

    expect(resolveCachedMessageThreadSpec).not.toHaveBeenCalled();
    expect(enqueueRoutedSystemEvent).toHaveBeenCalledTimes(1);
    expect(String(systemEventOptions().sessionKey)).not.toContain(":topic:");
    expect(String(systemEventOptions().sessionKey)).not.toContain(":group:");
  });

  it("skips the cache lookup entirely when no reaction was added", async () => {
    const handler = registerHandler(
      buildTelegramConfig({ topics: { [String(FORUM_TOPIC_ID)]: { enabled: true } } }),
    );

    // A removal-only update enqueues nothing, so it must not spend a cache lookup
    // or log an unresolved-topic warning.
    await handler(
      forumReactionContext({
        oldReaction: [{ type: "emoji", emoji: FIRE_EMOJI }],
        newReaction: [],
      }),
    );

    expect(resolveCachedMessageThreadSpec).not.toHaveBeenCalled();
    expect(enqueueRoutedSystemEvent).not.toHaveBeenCalled();
    expect(runtimeLog).not.toHaveBeenCalled();
  });
});
