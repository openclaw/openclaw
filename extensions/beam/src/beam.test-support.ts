import type { IncomingMessage, ServerResponse } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginServiceContextV2 } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import type {
  SessionCatalogHost,
  SessionCatalogTranscriptItem,
} from "openclaw/plugin-sdk/session-catalog";
import type { ActiveSessionCatalog } from "openclaw/plugin-sdk/session-catalog-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, assert, vi } from "vitest";
import { createBeamRequestHandler } from "./http.js";
import { createBeamMirrorRunner } from "./mirror.js";
import { createBeamStore, type BeamStore } from "./store.js";
import {
  BEAM_MAX_SESSIONS,
  BEAM_RETENTION_MS,
  type BeamStoredSession,
  type BeamUpload,
} from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
export function beamTestHandler(
  store: BeamStore,
  options: Partial<Parameters<typeof createBeamRequestHandler>[0]> = {},
  failureStatus = 500,
) {
  const handler = createBeamRequestHandler({
    resolveClient: () => ({ clientIp: "127.0.0.1", scopes: ["operator.write"] }),
    resolveControlUiBasePath: () => undefined,
    ...options,
    store,
  });
  return (req: IncomingMessage, res: ServerResponse) => {
    void handler(req, res).catch((error: unknown) => {
      if (!res.writableEnded) {
        res.statusCode = failureStatus;
        res.end(error instanceof Error ? error.message : "test handler failed");
      }
    });
  };
}

export function persistentBeamTestStore(pluginId = "beam") {
  resetPluginStateStoreForTests();
  const keyedStore = createPluginStateKeyedStoreV2ForTests<BeamStoredSession>(
    pluginId,
    {
      namespace: "sessions",
      maxEntries: BEAM_MAX_SESSIONS,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: BEAM_RETENTION_MS,
      env: { OPENCLAW_STATE_DIR: tempDirs.make("beam-store-") },
    },
    { assertCurrent() {} },
  );
  const store = createBeamStore({
    state: { openKeyedStoreV2: () => keyedStore },
  } as unknown as PluginRuntime);
  const close = async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  };
  return { keyedStore, store, close };
}

export const beamTestNow = Date.parse("2026-07-27T12:00:00.000Z");
export const beamTestLogger = { warn: () => {}, info: () => {}, error: () => {} };
export function beamTestServiceContext(): OpenClawPluginServiceContextV2 {
  return {
    config: {},
    stateDir: "/unused",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    scheduler: createTestPluginServiceScheduler(),
  };
}

export function beamTestBarrier() {
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  const run = vi.fn(async () => {
    started.resolve();
    await release.promise;
  });
  return { started: started.promise, release: release.resolve, run };
}

export type BeamTestSession = {
  threadId: string;
  name?: string;
  modelProvider?: string;
  recencyAt: number;
};
export const beamTestSessions = (ids: string[], recencyAt = beamTestNow): BeamTestSession[] =>
  ids.map((threadId) => ({ threadId, recencyAt }));

export function beamTestMirrorConfig(overrides: Record<string, unknown> = {}) {
  const mirror = {
    endpoint: "https://team.example/api/v1/beam/sessions",
    catalogs: ["claude", "codex", "beam"],
    ...overrides,
  };
  return { plugins: { entries: { beam: { enabled: true, config: { mirror } } } } };
}

export function createBeamTestRuntime(config: unknown): PluginRuntime {
  return { config: { current: () => config } } as unknown as PluginRuntime;
}

export function createBeamTestCatalog(
  params: {
    id?: string;
    sessions?: BeamTestSession[] | (() => BeamTestSession[]);
    items?: SessionCatalogTranscriptItem[] | ((threadId: string) => SessionCatalogTranscriptItem[]);
    hostCursor?: string;
    hostKind?: SessionCatalogHost["kind"];
    onList?: () => unknown;
    onRead?: (threadId: string) => unknown;
    processHomeFallbackAllowed?: boolean;
  } = {},
): ActiveSessionCatalog {
  const id = params.id ?? "claude";
  return {
    pluginId: id,
    id,
    label: id,
    processHomeFallbackAllowed: params.processHomeFallbackAllowed ?? true,
    list: async () => {
      await params.onList?.();
      const sessions = typeof params.sessions === "function" ? params.sessions() : params.sessions;
      return [
        {
          hostId: "gateway:local",
          label: "Local",
          kind: params.hostKind ?? "gateway",
          connected: true,
          ...(params.hostCursor ? { nextCursor: params.hostCursor } : {}),
          sessions: (sessions ?? [{ threadId: "t1", recencyAt: beamTestNow }]).map((session) => ({
            threadId: session.threadId,
            name: session.name,
            modelProvider: session.modelProvider,
            recencyAt: session.recencyAt,
            status: "stored",
            archived: false,
            canContinue: false,
            canArchive: false,
          })),
        },
      ];
    },
    read: async ({ hostId, threadId }) => {
      await params.onRead?.(threadId);
      const items = typeof params.items === "function" ? params.items(threadId) : params.items;
      return {
        hostId,
        label: "Local",
        threadId,
        items: items ?? [
          { type: "agentMessage", text: "Done." },
          { type: "userMessage", text: "Fix the flow." },
        ],
      };
    },
  };
}

type RunnerOptions = Parameters<typeof createBeamMirrorRunner>[0];
export function createBeamTestRunner({
  endpoint,
  listCatalogs = () => [createBeamTestCatalog()],
  ...options
}: Partial<RunnerOptions> & { endpoint?: string } = {}) {
  return createBeamMirrorRunner({
    runtime: createBeamTestRuntime(beamTestMirrorConfig(endpoint ? { endpoint } : {})),
    logger: beamTestLogger,
    now: () => beamTestNow,
    signal: new AbortController().signal,
    listCatalogs,
    ...options,
  });
}

export function createScheduledBeamTestRunner(options: Parameters<typeof createBeamTestRunner>[0]) {
  const scheduler = createTestPluginServiceScheduler();
  const runner = createBeamTestRunner({ ...options, signal: scheduler.signal });
  const settled = createDeferred<void>();
  scheduler.schedule({
    id: "mirror",
    delayMs: 0,
    everyMs: 30_000,
    run: () => runner.tick().finally(() => settled.resolve()),
  });
  return {
    tick: () => vi.advanceTimersByTimeAsync(0),
    stop: scheduler.stop,
    settled: settled.promise,
  };
}

export function beamMirrorTestFixture() {
  const sent: Array<{ auth?: string; payload: BeamUpload }> = [];
  const warnings: string[] = [];
  const logger = { warn: (message: string) => warnings.push(message), info: () => {} };
  const options = (
    catalog: Parameters<typeof createBeamTestCatalog>[0] = {},
    overrides: Partial<Parameters<typeof createBeamTestRunner>[0]> = {},
    response: {
      status?: (payload: BeamUpload) => number;
      cancel?: () => void | Promise<void>;
    } = {},
  ) => {
    const testCatalog = createBeamTestCatalog(catalog);
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      assert(typeof init?.body === "string", "expected Beam JSON request body");
      const payload = JSON.parse(init.body) as BeamUpload;
      const headers = (init.headers ?? {}) as Record<string, string>;
      sent.push({ payload, ...(headers.Authorization ? { auth: headers.Authorization } : {}) });
      const body = response.cancel
        ? new ReadableStream<Uint8Array>({ cancel: response.cancel })
        : "{}";
      return new Response(body, { status: response.status?.(payload) ?? 200 });
    });
    return {
      fetchFn: fetchFn as typeof fetch,
      logger,
      listCatalogs: () => [testCatalog],
      ...overrides,
    };
  };
  return {
    sent,
    warnings,
    logger,
    runner: (...args: Parameters<typeof options>) => createBeamTestRunner(options(...args)),
    scheduled: (...args: Parameters<typeof options>) =>
      createScheduledBeamTestRunner(options(...args)),
  };
}
