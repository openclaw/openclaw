// Telegram plugin module implements bot message context harness behavior.
import { createHash } from "node:crypto";
import type { Message } from "grammy/types";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { createTelegramMessageContextRuntime } from "./bot-handlers.message-context.js";
import type { BuildTelegramMessageContextParams, TelegramMediaRef } from "./bot-message-context.js";
import { resolveTelegramMessageThreadSpec, type TelegramThreadSpec } from "./bot/helpers.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import { setTelegramRuntime } from "./runtime.js";
import type { TelegramRuntime } from "./runtime.types.js";

export const baseTelegramMessageContextConfig = {
  agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
  channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
  messages: { groupChat: { mentionPatterns: [] } },
} as never;

type TelegramTestSessionRuntime = NonNullable<BuildTelegramMessageContextParams["sessionRuntime"]>;
type TopicNameEntryForTest = {
  name: string;
  iconColor?: number;
  iconCustomEmojiId?: string;
  closed?: boolean;
  updatedAt: number;
};

type BuildTelegramMessageContextForTestParams = {
  message: Record<string, unknown>;
  me?: Record<string, unknown>;
  allMedia?: TelegramMediaRef[];
  replyChain?: BuildTelegramMessageContextParams["replyChain"];
  promptContext?: BuildTelegramMessageContextParams["promptContext"];
  options?: BuildTelegramMessageContextParams["options"];
  cfg?: Record<string, unknown>;
  accountId?: string;
  dmPolicy?: BuildTelegramMessageContextParams["dmPolicy"];
  historyLimit?: number;
  dmHistoryLimit?: number;
  ackReactionScope?: BuildTelegramMessageContextParams["ackReactionScope"];
  botApi?: Record<string, unknown>;
  sendChatActionHandler?: BuildTelegramMessageContextParams["sendChatActionHandler"];
  runtime?: BuildTelegramMessageContextParams["runtime"];
  sessionRuntime?: BuildTelegramMessageContextParams["sessionRuntime"] | null;
  resolveGroupActivation?: BuildTelegramMessageContextParams["resolveGroupActivation"];
  resolveGroupRequireMention?: BuildTelegramMessageContextParams["resolveGroupRequireMention"];
  resolveTelegramGroupConfig?: BuildTelegramMessageContextParams["resolveTelegramGroupConfig"];
};

const telegramTopicNameStoresForTest = new Map<string, Map<string, TopicNameEntryForTest>>();

function resolveSessionStorePathForTest(testName: string | undefined): string {
  const hash = createHash("sha256")
    .update(`${process.pid}:${testName ?? "unknown"}`)
    .digest("hex")
    .slice(0, 16);
  return `/tmp/openclaw/session-store-${hash}.json`;
}

function createTelegramMessageContextSessionRuntimeForTest(
  storePath: string,
): TelegramTestSessionRuntime {
  return {
    buildChannelInboundEventContext,
    readAmbientTranscriptWatermark: () => undefined,
    readSessionUpdatedAt: () => undefined,
    recordInboundSession: async () => undefined,
    resolveAmbientTranscriptWatermarkKey: ({ channel, accountId, conversationId, threadId }) =>
      JSON.stringify([
        channel,
        accountId ?? "",
        conversationId,
        threadId === undefined ? "" : String(threadId),
      ]),
    resolveInboundLastRouteSessionKey: ({ route, sessionKey }) =>
      route.lastRoutePolicy === "main" ? route.mainSessionKey : sessionKey,
    resolvePinnedMainDmOwnerFromAllowlist: () => null,
    resolveStorePath: () => storePath,
  };
}

function installTelegramTopicNameStoreForTest() {
  setTelegramRuntime({
    state: {
      openKeyedStore: (({ namespace }: { namespace: string }) => {
        const entries = telegramTopicNameStoresForTest.get(namespace) ?? new Map();
        telegramTopicNameStoresForTest.set(namespace, entries);
        return {
          async register(key: string, value: TopicNameEntryForTest) {
            entries.set(key, value);
          },
          async entries() {
            return Array.from(entries, ([key, value]) => ({ key, value }));
          },
          async delete(key: string) {
            return entries.delete(key);
          },
          async clear() {
            entries.clear();
          },
        };
      }) as unknown as TelegramRuntime["state"]["openKeyedStore"],
    },
    channel: {},
  } as TelegramRuntime);
}

export async function buildTelegramMessageContextForTest(
  params: BuildTelegramMessageContextForTestParams,
): Promise<
  Awaited<ReturnType<typeof import("./bot-message-context.js").buildTelegramMessageContext>>
> {
  const { expect, vi } = await loadVitestModule();
  const buildTelegramMessageContext = await loadBuildTelegramMessageContext();
  const sessionRuntime =
    params.sessionRuntime === null
      ? undefined
      : {
          ...createTelegramMessageContextSessionRuntimeForTest(
            resolveSessionStorePathForTest(expect.getState().currentTestName),
          ),
          ...params.sessionRuntime,
        };
  return await buildTelegramMessageContext({
    primaryCtx: {
      message: {
        message_id: 1,
        date: 1_700_000_000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
        ...params.message,
      },
      me: { id: 7, username: "bot", ...params.me },
    } as never,
    allMedia: params.allMedia ?? [],
    replyChain: params.replyChain ?? [],
    promptContext: params.promptContext ?? [],
    storeAllowFrom: [],
    options: params.options ?? {},
    bot: {
      api: {
        sendChatAction: vi.fn(),
        setMessageReaction: vi.fn(),
        ...params.botApi,
      },
    } as never,
    cfg: (params.cfg ?? baseTelegramMessageContextConfig) as never,
    runtime: {
      recordChannelActivity: () => undefined,
      ...params.runtime,
    },
    sessionRuntime,
    account: { accountId: params.accountId ?? "default" } as never,
    historyLimit: params.historyLimit ?? 0,
    dmHistoryLimit: params.dmHistoryLimit ?? 10,
    dmPolicy: params.dmPolicy ?? "open",
    allowFrom: ["*"],
    groupAllowFrom: [],
    ackReactionScope: params.ackReactionScope ?? "off",
    logger: { info: vi.fn() },
    resolveGroupActivation: params.resolveGroupActivation ?? (() => undefined),
    resolveGroupRequireMention: params.resolveGroupRequireMention ?? (() => false),
    resolveTelegramGroupConfig:
      params.resolveTelegramGroupConfig ??
      (() => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      })),
    sendChatActionHandler: params.sendChatActionHandler ?? ({ sendChatAction: vi.fn() } as never),
  });
}

/** Exercise the same cache reader as ingress without a second history owner. */
export async function createTelegramCachedContextForTest(cfg: OpenClawConfig = {}) {
  const { expect } = await loadVitestModule();
  setTelegramPluginStateRuntimeForTests();
  const telegramCfg = cfg.channels?.telegram ?? { groupPolicy: "open" as const, historyLimit: 10 };
  const runtimeCfg = { ...cfg, channels: { ...cfg.channels, telegram: telegramCfg } };
  const runtime = createTelegramMessageContextRuntime({
    cfg: runtimeCfg,
    accountId: "default",
    ownerAgentId: "main",
    opts: {
      token: "test-token",
      botInfo: {
        id: 7,
        is_bot: true,
        username: "bot",
        first_name: "Bot",
        can_join_groups: true,
        can_read_all_group_messages: true,
        can_manage_bots: false,
        supports_inline_queries: false,
        supports_join_request_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
        has_topics_enabled: false,
        allows_users_to_create_topics: false,
      },
    },
    telegramCfg,
    telegramDeps: {
      resolveStorePath: () => resolveSessionStorePathForTest(expect.getState().currentTestName),
    } as never,
  });
  return {
    ...runtime,
    async read(message: Message | Record<string, unknown>, threadSpec?: TelegramThreadSpec) {
      const msg = {
        date: 1_700_000_000,
        from: { id: 42, is_bot: false, first_name: "Alice" },
        ...Object.fromEntries(Object.entries(message).filter(([, value]) => value !== undefined)),
      } as Message;
      const observedThread = threadSpec ?? resolveTelegramMessageThreadSpec(msg);
      await runtime.recordMessageForReplyChain(msg, observedThread);
      await runtime.markHistoryEligible({
        accountId: "default",
        chatId: msg.chat.id,
        messageIds: [String(msg.message_id)],
        botUserId: 7,
      });
      return await runtime.buildPromptContextForMessage(
        { me: { id: 7, is_bot: true, username: "bot", first_name: "Bot" } } as never,
        msg,
        await runtime.buildReplyChainForMessage(msg),
        runtimeCfg,
        telegramCfg,
        { threadSpec: observedThread },
      );
    },
  };
}

let buildTelegramMessageContextLoader:
  | typeof import("./bot-message-context.js").buildTelegramMessageContext
  | undefined;
let messageContextMocksInstalled = false;

async function loadBuildTelegramMessageContext() {
  await installMessageContextTestMocks();
  if (!buildTelegramMessageContextLoader) {
    ({ buildTelegramMessageContext: buildTelegramMessageContextLoader } =
      await import("./bot-message-context.js"));
  }
  return buildTelegramMessageContextLoader;
}

const loadVitestModule = createLazyRuntimeModule(() => import("vitest"));

async function installMessageContextTestMocks() {
  installTelegramTopicNameStoreForTest();
  if (messageContextMocksInstalled) {
    return;
  }
  messageContextMocksInstalled = true;
}
