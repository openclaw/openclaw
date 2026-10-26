import {
  buildChannelInboundEventContext,
  type runPreparedInboundReply,
  type PreparedInboundReply,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createPluginRuntimeMock,
  createTestInboundDebounceFlush,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsApp } from "./sdk.js";

type RuntimeRoutePeer = { accountId?: string | null; peer: { kind: string; id: string } };
type Channel = PluginRuntime["channel"];

type MSTeamsTestRuntimeOptions = {
  enqueueSystemEvent?: ReturnType<typeof vi.fn>;
  readAllowFromStore?: ReturnType<typeof vi.fn>;
  upsertPairingRequest?: ReturnType<typeof vi.fn>;
  recordInboundSession?: ReturnType<typeof vi.fn>;
  resolveAgentRoute?: (params: RuntimeRoutePeer) => unknown;
  hasControlCommand?: Channel["text"]["hasControlCommand"];
  createInboundDebouncer?: Channel["debounce"]["createInboundDebouncer"];
  resolveInboundDebounceMs?: Channel["debounce"]["resolveInboundDebounceMs"];
  resolveTextChunkLimit?: () => number;
  resolveStorePath?: () => string | undefined;
  runPrepared?: typeof runPreparedInboundReply;
};

const dispatchReplyWithBufferedBlockDispatcher = vi.fn(
  async (params: Parameters<Channel["reply"]["dispatchReplyWithBufferedBlockDispatcher"]>[0]) => {
    await params.dispatcherOptions.onSettled?.();
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  },
);

export function getMSTeamsTestRuntimeState() {
  return { dispatchReplyWithBufferedBlockDispatcher };
}

function createImmediateDebouncer<T>(params: {
  onFlush: (
    entries: T[],
    flush: typeof createTestInboundDebounceFlush,
  ) => { completion: Promise<void> };
}) {
  return {
    enqueue: async (entry: T) => {
      await params.onFlush([entry], createTestInboundDebounceFlush).completion;
    },
    flushKey: async () => {},
    cancelKey: () => false,
    drain: async () => {},
  };
}

export function installMSTeamsTestRuntime({
  recordInboundSession = vi.fn(async () => undefined),
  resolveStorePath = () => "/tmp/msteams-sessions.json",
  enqueueSystemEvent = vi.fn(),
  readAllowFromStore = vi.fn(async () => []),
  upsertPairingRequest = vi.fn(async () => null),
  hasControlCommand = () => false,
  resolveInboundDebounceMs = () => 0,
  createInboundDebouncer,
  resolveAgentRoute = ({ peer }: RuntimeRoutePeer) => ({
    sessionKey: `msteams:${peer.kind}:${peer.id}`,
    agentId: "default",
    accountId: "default",
  }),
  resolveTextChunkLimit,
  runPrepared: customRunPrepared,
}: MSTeamsTestRuntimeOptions = {}): void {
  const runPrepared = vi.fn(async (turn: PreparedInboundReply<unknown>) => {
    await turn.recordInboundSession({
      storePath: turn.storePath,
      sessionKey: turn.ctxPayload.SessionKey ?? turn.routeSessionKey,
      ctx: turn.ctxPayload,
      groupResolution: turn.record?.groupResolution,
      createIfMissing: turn.record?.createIfMissing,
      updateLastRoute: turn.record?.updateLastRoute,
      onRecordError: turn.record?.onRecordError ?? (() => undefined),
    });
    const dispatchResult = await turn.runDispatch();
    return {
      admission: { kind: "dispatch" as const },
      dispatched: true,
      ctxPayload: turn.ctxPayload,
      routeSessionKey: turn.routeSessionKey,
      dispatchResult,
    };
  });
  const run = vi.fn(async (params: Parameters<Channel["inbound"]["run"]>[0]) => {
    const input = await params.adapter.ingest(params.raw);
    // This fixture serves the already-admitted message adapter, not the generic ingress pipeline.
    if (!input || params.adapter.classify || params.adapter.preflight) {
      throw new Error("expected the MSTeams message adapter without ingress hooks");
    }
    const turn = await params.adapter.resolveTurn(
      input,
      { kind: "message", canStartAgentTurn: true },
      {},
    );
    if (!("route" in turn) || !("delivery" in turn)) {
      throw new Error("expected assembled MSTeams channel turn plan");
    }
    const preparedTurn = {
      channel: turn.channel,
      accountId: turn.accountId,
      routeSessionKey: turn.route.sessionKey,
      storePath: resolveStorePath(),
      ctxPayload: turn.ctxPayload,
      recordInboundSession,
      afterRecord: turn.afterRecord,
      record: turn.record,
      history: turn.history,
      admission: turn.admission,
      botLoopProtection: turn.botLoopProtection,
      runDispatch: async () =>
        await dispatchReplyWithBufferedBlockDispatcher({
          ctx: turn.ctxPayload,
          cfg: turn.cfg,
          dispatcherOptions: {
            ...turn.dispatcherOptions,
            deliver: turn.delivery.deliver,
            onError: turn.delivery.onError,
          },
          toolsAllow: turn.toolsAllow,
          replyOptions: turn.replyOptions,
          replyResolver: turn.replyResolver,
        }),
    } as PreparedInboundReply<unknown>;
    return await (customRunPrepared ?? runPrepared)(preparedTurn);
  });
  setMSTeamsRuntime({
    logging: { shouldLogVerbose: () => false },
    system: { enqueueSystemEvent },
    channel: {
      debounce: {
        resolveInboundDebounceMs,
        createInboundDebouncer: createInboundDebouncer ?? createImmediateDebouncer,
      },
      pairing: { readAllowFromStore, upsertPairingRequest },
      commands: {
        isControlCommandMessage: hasControlCommand,
        shouldComputeCommandAuthorized: hasControlCommand,
        shouldHandleTextCommands: () => true,
      },
      text: {
        hasControlCommand,
        resolveChunkMode: () => "length",
        resolveMarkdownTableMode: () => "code",
        ...(resolveTextChunkLimit ? { resolveTextChunkLimit } : {}),
      },
      routing: { resolveAgentRoute },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher,
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ctx,
        resolveHumanDelayConfig: () => undefined,
      },
      session: { recordInboundSession, resolveStorePath },
      inbound: {
        ingress: createPluginRuntimeMock().channel.inbound.ingress,
        buildContext: buildChannelInboundEventContext,
        run: run as unknown as Channel["inbound"]["run"],
      },
    },
  } as unknown as PluginRuntime);
}

export function createMSTeamsMessageHandlerDeps(params?: {
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
}): MSTeamsMessageHandlerDeps {
  return {
    cfg: params?.cfg ?? {},
    runtime: (params?.runtime ?? { error: vi.fn() }) as RuntimeEnv,
    accountId: "default",
    appId: "test-app-id",
    app: {} as MSTeamsApp,
    tokenProvider: { getAccessToken: async () => "token" },
    textLimit: 4000,
    mediaMaxBytes: 8 * 1024 * 1024,
    conversationStore: {
      upsert: async () => {},
      get: async () => null,
      list: async () => [],
      remove: async () => false,
      findPreferredDmByUserId: async () => null,
    },
    pollStore: {
      createPoll: async () => {},
      getPoll: async () => null,
      recordVote: async () => null,
    },
    log: { info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}
