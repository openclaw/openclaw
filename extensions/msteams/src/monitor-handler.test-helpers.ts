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
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { cleanupSessionStateForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { useAutoCleanupTempDirTracker, useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { afterEach, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsApp } from "./sdk.js";

type RuntimeRoutePeer = { accountId?: string | null; peer: { kind: string; id: string } };
type Channel = PluginRuntime["channel"];

useIsolatedStateGuard();

type MSTeamsTestRuntimeOptions = {
  enqueueSystemEvent?: ReturnType<typeof vi.fn>;
  readAllowFromStore?: ReturnType<typeof vi.fn>;
  upsertPairingRequest?: ReturnType<typeof vi.fn>;
  resolveAgentRoute?: (params: RuntimeRoutePeer) => unknown;
  hasControlCommand?: Channel["text"]["hasControlCommand"];
  createInboundDebouncer?: Channel["debounce"]["createInboundDebouncer"];
  resolveInboundDebounceMs?: Channel["debounce"]["resolveInboundDebounceMs"];
  resolveTextChunkLimit?: () => number;
};

const dispatchReplyFromConfig = vi.fn<
  NonNullable<ChannelInboundTurnPlan["dispatchReplyFromConfig"]>
>(async () => ({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } }));
const stateDirs = new Map<string, string>();
const sessionTasks = new Set<Promise<unknown>>();
let ownsRuntimeConfigSnapshot = false;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    // Session stores own agent handles under the fixture root, but their leases
    // use the captured ambient shared state DB. Join both before removing roots.
    const reporting = await Promise.allSettled(sessionTasks);
    const cleanupResults = await Promise.allSettled(
      [...stateDirs].map(([rootPath, stateDir]) =>
        cleanupSessionStateForTest({ rootPath, stateDir }),
      ),
    );
    const errors = [...reporting, ...cleanupResults].flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) {
      throw new AggregateError(errors, "MSTeams session fixture cleanup failed");
    }
    cleanup();
    stateDirs.clear();
    sessionTasks.clear();
    if (ownsRuntimeConfigSnapshot) {
      clearRuntimeConfigSnapshot();
      ownsRuntimeConfigSnapshot = false;
    }
  }),
);

export function getMSTeamsTestRuntimeState() {
  return { dispatchReplyFromConfig };
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
}: MSTeamsTestRuntimeOptions = {}) {
  const testHome = process.env.OPENCLAW_TEST_HOME;
  if (!testHome) {
    throw new Error("MSTeams session fixtures require the isolated test home");
  }
  const stateDir = resolveStateDir();
  const rootPath = tempDirs.make("msteams-sessions-", testHome);
  stateDirs.set(rootPath, stateDir);
  const storePath = path.join(rootPath, "agents", "{agentId}", "sessions", "sessions.json");
  const run = <TRaw, TDispatchResult>(
    params: ChannelInboundEventRunnerParams<TRaw, TDispatchResult>,
  ) =>
    runChannelInboundEvent<TRaw, TDispatchResult>({
      ...params,
      adapter: {
        ...params.adapter,
        resolveTurn: async (...args) => {
          const turn = await params.adapter.resolveTurn(...args);
          if (!("route" in turn) || !("delivery" in turn)) {
            throw new Error("expected assembled MSTeams channel turn plan");
          }
          return {
            ...turn,
            cfg: { ...turn.cfg, session: { ...turn.cfg.session, store: storePath } },
            dispatchReplyFromConfig,
            record: {
              ...turn.record,
              trackSessionMetaTask: (task) => {
                sessionTasks.add(task);
                void task.catch(() => undefined);
                turn.record?.trackSessionMetaTask?.(task);
              },
            },
          };
        },
      },
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
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ctx,
        resolveHumanDelayConfig: () => undefined,
      },
      inbound: {
        ingress: createPluginRuntimeMock().channel.inbound.ingress,
        buildContext: buildChannelInboundEventContext,
        run,
      },
    },
  } as unknown as PluginRuntime);
  return { storePath };
}

export function createMSTeamsMessageHandlerDeps(params?: {
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
}): MSTeamsMessageHandlerDeps {
  const cfg = params?.cfg ?? {};
  // Real history readers need prepared runtime config; preserve snapshots owned by reload tests.
  if (!getRuntimeConfigSnapshot()) {
    setRuntimeConfigSnapshot(cfg);
    ownsRuntimeConfigSnapshot = true;
  }
  return {
    cfg,
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
