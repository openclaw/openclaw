// Msteams helper module supports monitor handler helpers behavior.
import path from "node:path";
import {
  buildChannelInboundEventContext,
  runChannelInboundEvent,
  type ChannelInboundEventRunnerParams,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createPluginRuntimeMock,
  createTestInboundDebounceFlush,
} from "openclaw/plugin-sdk/channel-test-helpers";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker, useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, aroundAll, beforeEach, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsActivityHandler } from "./monitor-handler.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import type { MSTeamsPollStore } from "./polls.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsApp } from "./sdk.js";

type RuntimeRoutePeer = { peer: { kind: string; id: string } };

type MSTeamsTestRuntimeOptions = {
  enqueueSystemEvent?: ReturnType<typeof vi.fn>;
  readAllowFromStore?: ReturnType<typeof vi.fn>;
  upsertPairingRequest?: ReturnType<typeof vi.fn>;
  resolveAgentRoute?: (params: RuntimeRoutePeer) => unknown;
  hasControlCommand?: PluginRuntime["channel"]["text"]["hasControlCommand"];
  isControlCommandMessage?: PluginRuntime["channel"]["commands"]["isControlCommandMessage"];
  shouldComputeCommandAuthorized?: PluginRuntime["channel"]["commands"]["shouldComputeCommandAuthorized"];
  shouldHandleTextCommands?: PluginRuntime["channel"]["commands"]["shouldHandleTextCommands"];
  createInboundDebouncer?: PluginRuntime["channel"]["debounce"]["createInboundDebouncer"];
  resolveInboundDebounceMs?: PluginRuntime["channel"]["debounce"]["resolveInboundDebounceMs"];
  resolveTextChunkLimit?: () => number;
};

const testHome = process.env.OPENCLAW_TEST_HOME;
if (!testHome) {
  throw new Error("MSTeams fixtures require the shared isolated test home.");
}
// Keep lock identity stable through metadata work and teardown, outside per-turn state.
aroundAll((runSuite) =>
  withStateDatabaseCoordinatorRuntimeDirectory(
    path.join(testHome, ".runtime", "msteams-coordinators"),
    runSuite,
  ),
);
afterAll(async () => {
  // Vitest unwinds this hook before shared setup removes the home. Agent leases
  // can reopen shared state, so release them before closing the shared owner.
  await closeOpenClawAgentDatabasesAsync(testHome);
  await closeOpenClawStateDatabaseAsync();
});
useIsolatedStateGuard();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    // Metadata writes can retain maintenance workers beyond the recording promise.
    await Promise.all([...tempDirs.dirs].map((dir) => closeOpenClawAgentDatabasesAsync(dir)));
    cleanup();
  });
});
const dispatchReplyFromConfig =
  vi.fn<NonNullable<ChannelInboundTurnPlan["dispatchReplyFromConfig"]>>();
const onFinalize =
  vi.fn<
    (
      result: Parameters<
        NonNullable<ChannelInboundEventRunnerParams<unknown>["adapter"]["onFinalize"]>
      >[0],
    ) => void
  >();

beforeEach(() => {
  onFinalize.mockReset();
  dispatchReplyFromConfig.mockReset().mockResolvedValue({
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  });
});

export function getMSTeamsTestRuntimeState() {
  return { dispatchReplyFromConfig, onFinalize };
}

export function installMSTeamsTestRuntime(options: MSTeamsTestRuntimeOptions = {}) {
  let storePath: string | undefined;
  const resolveStorePath = () => {
    if (!storePath) {
      storePath = path.join(
        tempDirs.make("msteams-turn-", process.env.OPENCLAW_TEST_HOME),
        "sessions.json",
      );
    }
    return storePath;
  };
  const run = async (params: ChannelInboundEventRunnerParams<unknown>) => {
    const metadataTasks: Promise<unknown>[] = [];
    try {
      return await runChannelInboundEvent({
        ...params,
        adapter: {
          ...params.adapter,
          onFinalize: (result) => {
            // Observe core completion before the fixture joins detached metadata writes.
            onFinalize(result);
            return params.adapter.onFinalize?.(result);
          },
          resolveTurn: async (...args) => {
            const turn = await params.adapter.resolveTurn(...args);
            if (!("route" in turn) || !("delivery" in turn)) {
              throw new Error("expected routed MSTeams channel turn plan");
            }
            return {
              ...turn,
              cfg: { ...turn.cfg, session: { ...turn.cfg.session, store: resolveStorePath() } },
              dispatchReplyFromConfig,
              record: {
                ...turn.record,
                trackSessionMetaTask: (task: Promise<unknown>) => {
                  metadataTasks.push(task);
                  turn.record?.trackSessionMetaTask?.(task);
                },
              },
            };
          },
        },
      });
    } finally {
      // The recorder detaches metadata writes; join them before assertions or fixture cleanup.
      await Promise.all(metadataTasks);
    }
  };
  setMSTeamsRuntime({
    logging: { shouldLogVerbose: () => false },
    system: { enqueueSystemEvent: options.enqueueSystemEvent ?? vi.fn() },
    channel: {
      debounce: {
        resolveInboundDebounceMs:
          options.resolveInboundDebounceMs ??
          ((() => 0) as PluginRuntime["channel"]["debounce"]["resolveInboundDebounceMs"]),
        createInboundDebouncer:
          options.createInboundDebouncer ??
          (<T>(params: {
            onFlush: (
              entries: T[],
              createFlush: typeof createTestInboundDebounceFlush,
            ) => { completion: Promise<void> };
          }) => ({
            enqueue: async (entry: T) => {
              await params.onFlush([entry], createTestInboundDebounceFlush).completion;
            },
            flushKey: async () => {},
            cancelKey: () => false,
            drain: async () => {},
          })),
      },
      pairing: {
        readAllowFromStore: options.readAllowFromStore ?? vi.fn(async () => []),
        upsertPairingRequest: options.upsertPairingRequest ?? vi.fn(async () => null),
      },
      commands: {
        isControlCommandMessage:
          options.isControlCommandMessage ?? options.hasControlCommand ?? (() => false),
        shouldComputeCommandAuthorized:
          options.shouldComputeCommandAuthorized ?? options.hasControlCommand ?? (() => false),
        shouldHandleTextCommands: options.shouldHandleTextCommands ?? (() => true),
      },
      text: {
        hasControlCommand: options.hasControlCommand ?? (() => false),
        resolveChunkMode: () => "length",
        resolveMarkdownTableMode: () => "code",
        ...(options.resolveTextChunkLimit
          ? { resolveTextChunkLimit: options.resolveTextChunkLimit }
          : {}),
      },
      routing: {
        resolveAgentRoute:
          options.resolveAgentRoute ??
          (({ peer }: RuntimeRoutePeer) => ({
            sessionKey: `agent:main:msteams:${peer.kind}:${peer.id}`,
            agentId: "main",
            accountId: "default",
          })),
      },
      reply: {
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ctx,
        resolveHumanDelayConfig: () => undefined,
      },
      inbound: {
        ingress: createPluginRuntimeMock().channel.inbound.ingress,
        buildContext: buildChannelInboundEventContext,
        run: run as unknown as PluginRuntime["channel"]["inbound"]["run"],
      },
    },
  } as unknown as PluginRuntime);
  return { resolveStorePath };
}

export function createActivityHandler(
  run = vi.fn(async () => undefined),
): MSTeamsActivityHandler & {
  run: NonNullable<MSTeamsActivityHandler["run"]>;
} {
  const handler: MSTeamsActivityHandler & {
    run: NonNullable<MSTeamsActivityHandler["run"]>;
  } = {
    onMessage: () => handler,
    onMembersAdded: () => handler,
    onReactionsAdded: () => handler,
    onReactionsRemoved: () => handler,
    run,
  };
  return handler;
}

export function createMSTeamsMessageHandlerDeps(params?: {
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
}): MSTeamsMessageHandlerDeps {
  const app = {
    tokenManager: {
      getBotToken: async () => ({ toString: () => "bot-token" }),
      getGraphToken: async () => ({ toString: () => "graph-token" }),
    },
    api: {},
    graph: {},
    send: async () => ({ id: "sent" }),
    initialize: async () => {},
    on: () => {},
  } as unknown as MSTeamsApp;
  const conversationStore: MSTeamsConversationStore = {
    upsert: async () => {},
    get: async () => null,
    list: async () => [],
    remove: async () => false,
    findPreferredDmByUserId: async () => null,
  };
  const pollStore: MSTeamsPollStore = {
    createPoll: async () => {},
    getPoll: async () => null,
    recordVote: async () => null,
  };

  return {
    cfg: params?.cfg ?? {},
    runtime: (params?.runtime ?? { error: vi.fn() }) as RuntimeEnv,
    appId: "test-app-id",
    app,
    tokenProvider: {
      getAccessToken: async () => "token",
    },
    textLimit: 4000,
    mediaMaxBytes: 8 * 1024 * 1024,
    conversationStore,
    pollStore,
    log: {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}
