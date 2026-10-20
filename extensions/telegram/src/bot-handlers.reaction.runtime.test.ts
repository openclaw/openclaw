import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
import {
  registerSessionBindingAdapter,
  testing as sessionBindingTesting,
} from "openclaw/plugin-sdk/session-binding-runtime";
import { peekSystemEventEntries } from "openclaw/plugin-sdk/system-event-runtime";
import { resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramEventBindings } from "./bot-handlers.event-bindings.js";
import { createTelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import { createTelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { makeTelegramConfig } from "./bot.config.test-support.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import { setTelegramRuntime } from "./runtime.js";

const FIRE_EMOJI = "\u{1F525}";
const { enqueueRoutedSystemEvent: enqueueActualSystemEvent } = await vi.importActual<
  typeof import("openclaw/plugin-sdk/system-event-runtime")
>("openclaw/plugin-sdk/system-event-runtime");
const FORUM_CHAT_ID = -1005678;
const FORUM_TOPIC_ID = 77;
const REACTED_MESSAGE_ID = 100;

type ReactionHandler = (ctx: Record<string, unknown>) => Promise<void>;
type TelegramConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>;

const { enqueueRoutedSystemEvent, wasSentByBotMock } = vi.hoisted(() => ({
  enqueueRoutedSystemEvent: vi.fn(),
  wasSentByBotMock: vi.fn<() => boolean | Promise<boolean>>(),
}));
vi.mock("openclaw/plugin-sdk/system-event-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/system-event-runtime")>()),
  enqueueRoutedSystemEvent,
}));
vi.mock("./sent-message-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sent-message-cache.js")>()),
  wasSentByBot: async () => await wasSentByBotMock(),
}));
const runtimeLog = vi.fn();
const resolveCachedMessageThreadSpec = vi.fn<
  ReturnType<typeof createTelegramMessagePipeline>["resolveCachedMessageThreadSpec"]
>(async () => undefined);

function buildTelegramConfig({
  topics,
  ...telegram
}: {
  topics?: Record<string, { enabled?: boolean; agentId?: string }>;
} & TelegramConfig = {}): OpenClawConfig {
  return makeTelegramConfig({
    dmPolicy: "open",
    allowFrom: ["*"],
    reactionNotifications: "all",
    groupPolicy: "open",
    groups: { [String(FORUM_CHAT_ID)]: { enabled: true, topics } },
    ...telegram,
  });
}

// Real authorization proves topic-scoped config lookup, not just handler branching.
function registerHandler(
  cfg: OpenClawConfig,
  wasSentByBot: () => boolean | Promise<boolean> = () => true,
): ReactionHandler {
  setRuntimeConfigSnapshot(cfg);
  wasSentByBotMock.mockImplementation(wasSentByBot);
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
    runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
    shouldSkipUpdate: () => false,
    resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
    resolveGroupActivation: () => undefined,
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig: (chatId, messageThreadId, config) =>
      resolveTelegramScopedGroupConfig(config.channels?.telegram ?? {}, chatId, messageThreadId),
    processMessage: vi.fn<RegisterTelegramHandlerParams["processMessage"]>(),
  };

  createTelegramEventBindings({
    params,
    message: {
      ...createTelegramMessagePipeline(params),
      resolveCachedMessageThreadSpec,
    },
    authorization: createTelegramHandlerAuthorization(params),
  }).registerReaction();
  const handler = handlers.get("message_reaction");
  if (!handler) {
    throw new Error("expected message_reaction handler");
  }
  return handler;
}

function forumReactionContext(overrides?: {
  oldReaction?: string[];
  newReaction?: string[];
  user?: { id: number; first_name: string; is_bot?: boolean };
  isForum?: boolean;
  isDirectMessages?: boolean;
  chatType?: string;
}) {
  return {
    messageReaction: {
      chat: {
        id: overrides?.chatType === "private" ? 5678 : FORUM_CHAT_ID,
        type: overrides?.chatType ?? "supergroup",
        ...(overrides?.isForum === false ? {} : { is_forum: true }),
        ...(overrides?.isDirectMessages ? { is_direct_messages: true } : {}),
      },
      message_id: REACTED_MESSAGE_ID,
      user: overrides?.user ?? { id: 10, first_name: "Bob", username: "bob_user" },
      old_reaction: (overrides?.oldReaction ?? []).map(emojiReaction),
      new_reaction: (overrides?.newReaction ?? [FIRE_EMOJI]).map(emojiReaction),
    },
  };
}

function emojiReaction(emoji: string) {
  return { type: "emoji", emoji };
}

function privateReaction(overrides?: Parameters<typeof forumReactionContext>[0]) {
  return forumReactionContext({ isForum: false, chatType: "private", ...overrides });
}

function reactionEvent(emoji = FIRE_EMOJI, chatId?: number) {
  return expect.objectContaining({
    text: `Telegram reaction added: ${emoji} by Bob (@bob_user) on msg 100`,
    ...(chatId === undefined
      ? {}
      : { contextKey: `telegram:reaction:add:${chatId}:100:10:${emoji}` }),
  });
}

function expectRoutedTo(...parts: string[]) {
  expect(enqueueRoutedSystemEvent).toHaveBeenCalledTimes(1);
  const sessionKey = String(enqueueRoutedSystemEvent.mock.calls[0]?.[1]?.sessionKey);
  for (const part of parts) {
    expect(sessionKey).toContain(part);
  }
}

describe("registerTelegramReactionHandler forum topic recovery", () => {
  beforeEach(() => {
    setTelegramRuntime(createPluginRuntimeMock());
    resetSystemEventsForTest();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    enqueueRoutedSystemEvent.mockReset();
    runtimeLog.mockClear();
    resolveCachedMessageThreadSpec.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetSystemEventsForTest();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
  });

  it("keeps reaction content in the system event, not verbose diagnostics", async () => {
    const log = vi.spyOn(runtimeEnv, "logVerbose").mockImplementation(() => {});
    enqueueRoutedSystemEvent.mockImplementation(enqueueActualSystemEvent);
    await registerHandler(buildTelegramConfig())(privateReaction());
    expect(peekSystemEventEntries("agent:main:main")[0]?.text).toContain(FIRE_EMOJI);
    const diagnostics = log.mock.calls.map(([line]) => line).join("\n");
    expect(diagnostics).not.toContain("Bob");
    expect(diagnostics).not.toContain(FIRE_EMOJI);
  });

  it.each(["private", "supergroup"] as const)(
    "authorizes %s reaction senders before queueing distinct additions",
    async (chatType) => {
      const cfg = buildTelegramConfig({
        dmPolicy: "allowlist",
        allowFrom: ["10"],
        groupPolicy: "allowlist",
        groupAllowFrom: ["10"],
        groups: undefined,
      });
      enqueueRoutedSystemEvent.mockImplementation(enqueueActualSystemEvent);
      const handler = registerHandler(cfg);
      const context = (overrides?: Parameters<typeof forumReactionContext>[0]) =>
        forumReactionContext({ isForum: false, chatType, ...overrides });
      const sessionKey =
        chatType === "private" ? "agent:main:main" : "agent:main:telegram:group:-1005678";
      await handler(context({ user: { id: 11, first_name: "Denied" } }));
      expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      await handler(
        context({
          oldReaction: [FIRE_EMOJI],
          newReaction: [FIRE_EMOJI, "\u{1F44D}", "\u{1F389}"],
        }),
      );
      expect(peekSystemEventEntries(sessionKey)).toEqual(
        ["\u{1F44D}", "\u{1F389}"].map((emoji) =>
          reactionEvent(emoji, chatType === "private" ? 5678 : FORUM_CHAT_ID),
        ),
      );
    },
  );

  it("keeps default own, off, and all notification modes distinct", async () => {
    enqueueRoutedSystemEvent.mockImplementation(enqueueActualSystemEvent);
    const cfg = makeTelegramConfig({ dmPolicy: "open", allowFrom: ["*"] });
    const context = privateReaction();
    for (const [mode, sentByBot, expected] of [
      [undefined, false, []],
      [undefined, true, [reactionEvent()]],
      ["off", true, []],
      ["all", false, [reactionEvent()]],
    ] as const) {
      cfg.channels!.telegram!.reactionNotifications = mode;
      await registerHandler(cfg, () => sentByBot)(context);
      expect(peekSystemEventEntries("agent:main:main")).toEqual(expected);
      resetSystemEventsForTest();
    }
  });

  it("does not queue bot actors, unchanged reactions, or removals", async () => {
    enqueueRoutedSystemEvent.mockImplementation(enqueueActualSystemEvent);
    const handler = registerHandler(buildTelegramConfig());
    await handler(privateReaction({ user: { id: 10, first_name: "Bot", is_bot: true } }));
    for (const newReaction of [[FIRE_EMOJI], []]) {
      await handler(privateReaction({ oldReaction: [FIRE_EMOJI], newReaction }));
    }
    expect(peekSystemEventEntries("agent:main:main")).toEqual([]);
  });

  it("keeps a reaction on the runtime-bound global owner's queue", async () => {
    const cfg = {
      ...buildTelegramConfig(),
      agents: { entries: { main: {}, research: {} } },
      bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "default" } }],
    };
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
    expect(peekSystemEventEntries("agent:research:global")).toEqual([reactionEvent()]);
    expect(peekSystemEventEntries("agent:main:global")).toEqual([]);
  });

  it.each(["forum", "direct-messages"] as const)(
    "routes a recovered %s topic through its configured agent",
    async (scope) => {
      const isDirectMessages = scope === "direct-messages";
      const agentId = isDirectMessages ? "direct-topic-agent" : "topicbot";
      resolveCachedMessageThreadSpec.mockResolvedValue({ scope, id: FORUM_TOPIC_ID });
      await registerHandler(
        buildTelegramConfig({
          topics: { [String(FORUM_TOPIC_ID)]: { enabled: true, agentId } },
        }),
      )(forumReactionContext({ isForum: !isDirectMessages, isDirectMessages }));
      expectRoutedTo(agentId);
      if (isDirectMessages) {
        expectRoutedTo(`telegram:group:${FORUM_CHAT_ID}:direct-topic:${FORUM_TOPIC_ID}`);
      }
    },
  );

  it("applies the recovered topic's disabled config instead of the General topic's", async () => {
    resolveCachedMessageThreadSpec.mockResolvedValue({ scope: "forum", id: FORUM_TOPIC_ID });
    await registerHandler(
      buildTelegramConfig({
        topics: { "1": { enabled: true }, [String(FORUM_TOPIC_ID)]: { enabled: false } },
      }),
    )(forumReactionContext());
    expect(enqueueRoutedSystemEvent).not.toHaveBeenCalled();
  });

  it.each([
    { scope: "forum", recovered: undefined },
    { scope: "direct-messages", recovered: undefined },
    { scope: "direct-messages", recovered: { scope: "forum", id: FORUM_TOPIC_ID } },
  ] as const)(
    "drops unresolved $scope topic ($recovered), never guessing General",
    async ({ scope, recovered }) => {
      resolveCachedMessageThreadSpec.mockResolvedValue(recovered);
      await registerHandler(buildTelegramConfig({ topics: { "1": { enabled: true } } }))(
        forumReactionContext({
          isForum: scope === "forum",
          isDirectMessages: scope === "direct-messages",
        }),
      );
      expect(enqueueRoutedSystemEvent).not.toHaveBeenCalled();
      expect(runtimeLog).toHaveBeenCalledTimes(1);
      const logged = String(runtimeLog.mock.calls[0]?.[0] ?? "");
      expect(logged).toContain("thread-context-unavailable");
      expect(logged).toContain(`chat=${FORUM_CHAT_ID}`);
      expect(logged).toContain(`message=${REACTED_MESSAGE_ID}`);
      expect(logged).not.toContain("bob_user");
      expect(logged).not.toContain(FIRE_EMOJI);
    },
  );

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
});
