// Telegram plugin module implements bot message context harness behavior.
import { createHash } from "node:crypto";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type {
  BuildTelegramMessageContextParams,
  TelegramMediaRef,
  TelegramMessageContext,
} from "./bot-message-context.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import { getOptionalTelegramRuntime } from "./runtime.js";

const baseTelegramMessageContextConfig = {
  agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
  channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
  messages: { groupChat: { mentionPatterns: [] } },
} as never;

type TelegramTestSessionRuntime = NonNullable<BuildTelegramMessageContextParams["sessionRuntime"]>;

type BuildTelegramMessageContextForTestParams = {
  message: Record<string, unknown>;
  allMedia?: TelegramMediaRef[];
  replyChain?: BuildTelegramMessageContextParams["replyChain"];
  promptContext?: BuildTelegramMessageContextParams["promptContext"];
  options?: BuildTelegramMessageContextParams["options"];
  cfg?: Record<string, unknown>;
  historyLimit?: number;
  botApi?: Record<string, unknown>;
  sendChatActionHandler?: BuildTelegramMessageContextParams["sendChatActionHandler"];
  sessionRuntime?: null;
  resolveGroupActivation?: BuildTelegramMessageContextParams["resolveGroupActivation"];
  resolveTelegramGroupConfig?: BuildTelegramMessageContextParams["resolveTelegramGroupConfig"];
};

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

export async function buildTelegramMessageContextForTest(
  params: BuildTelegramMessageContextForTestParams,
): Promise<TelegramMessageContext | null> {
  const { expect, vi } = await loadVitestModule();
  // Standalone context tests need ingress authority; preserve a caller-owned runtime.
  if (!getOptionalTelegramRuntime()) {
    setTelegramPluginStateRuntimeForTests();
  }
  const buildTelegramMessageContext = await loadBuildTelegramMessageContext();
  const sessionRuntime =
    params.sessionRuntime === null
      ? undefined
      : createTelegramMessageContextSessionRuntimeForTest(
          resolveSessionStorePathForTest(expect.getState().currentTestName),
        );
  return await buildTelegramMessageContext({
    primaryCtx: {
      message: {
        message_id: 1,
        date: 1_700_000_000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
        ...params.message,
      },
      me: { id: 7, username: "bot" },
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
    },
    sessionRuntime,
    account: { accountId: "default" } as never,
    historyLimit: params.historyLimit ?? 0,
    dmHistoryLimit: 10,
    dmPolicy: "open",
    allowFrom: ["*"],
    groupAllowFrom: [],
    ackReactionScope: "off",
    logger: { info: vi.fn() },
    resolveGroupActivation: params.resolveGroupActivation ?? (() => undefined),
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig:
      params.resolveTelegramGroupConfig ??
      (() => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      })),
    sendChatActionHandler: params.sendChatActionHandler ?? ({ sendChatAction: vi.fn() } as never),
  });
}

let buildTelegramMessageContextLoader:
  | typeof import("./bot-message-context.js").buildTelegramMessageContext
  | undefined;

async function loadBuildTelegramMessageContext() {
  if (!buildTelegramMessageContextLoader) {
    ({ buildTelegramMessageContext: buildTelegramMessageContextLoader } =
      await import("./bot-message-context.js"));
  }
  return buildTelegramMessageContextLoader;
}

const loadVitestModule = createLazyRuntimeModule(() => import("vitest"));
