import type { IncomingMessage, ServerResponse } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { GatewayRequestAuthorityV1 } from "openclaw/plugin-sdk/gateway-request-authority";
import type { OpenClawPluginServiceContextV2 } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import type {
  PluginServiceExportCatalog,
  SessionCatalogHost,
  SessionCatalogTranscriptItem,
} from "openclaw/plugin-sdk/session-catalog";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, assert, vi } from "vitest";
import * as cleaner from "./cleaner.js";
import { createBeamRequestHandler } from "./http.js";
import { createBeamMirrorRunner } from "./mirror.js";
import { createBeamStore, type BeamStore } from "./store.js";
import {
  BEAM_MAX_SESSIONS,
  BEAM_MAX_WRITE_RECEIPTS,
  BEAM_RETENTION_MS,
  type BeamStoredSession,
  type BeamUpload,
} from "./types.js";

afterEach(() => vi.restoreAllMocks());
export function beamTestAuthority(
  overrides: Partial<GatewayRequestAuthorityV1> = {},
): GatewayRequestAuthorityV1 {
  return {
    clientIp: "127.0.0.1",
    scopes: ["operator.write"],
    assertCurrent() {},
    async revalidate() {},
    ...overrides,
  };
}
export function beamTestHandler(
  store: BeamStore,
  options: Partial<Parameters<typeof createBeamRequestHandler>[0]> = {},
  failureStatus = 500,
) {
  const handler = createBeamRequestHandler({
    resolveAuthority: beamTestAuthority,
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

export async function persistentBeamTestStore() {
  resetPluginStateStoreForTests();
  const state = await createOpenClawTestState({ label: "beam-store" });
  const env = state.env;
  const keyedStore = createPluginStateKeyedStoreV2ForTests<BeamStoredSession>(
    "beam",
    {
      namespace: "sessions",
      maxEntries: BEAM_MAX_SESSIONS,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: BEAM_RETENTION_MS,
      env,
    },
    { assertCurrent() {} },
  );
  const handoffStore = createPluginStateKeyedStoreV2ForTests<BeamStoredSession>(
    "beam",
    { namespace: "handoffs", retention: "retained", env },
    { assertCurrent() {} },
  );
  const writeStore = createPluginStateKeyedStoreV2ForTests(
    "beam",
    {
      namespace: "publication-requests",
      maxEntries: BEAM_MAX_WRITE_RECEIPTS,
      overflowPolicy: "reject-new",
      defaultTtlMs: BEAM_RETENTION_MS,
      env,
    },
    { assertCurrent() {} },
  );
  const imageStore = createPluginStateKeyedStoreV2ForTests(
    "beam",
    {
      namespace: "publication-images",
      maxEntries: BEAM_MAX_SESSIONS,
      overflowPolicy: "reject-new",
      defaultTtlMs: BEAM_RETENTION_MS,
      env,
    },
    { assertCurrent() {} },
  );
  const store = createBeamStore({
    state: {
      openKeyedStoreV2: ({ namespace }: { namespace: string }) =>
        namespace === "publication-images"
          ? imageStore
          : namespace === "handoffs"
            ? handoffStore
            : namespace === "publication-requests"
              ? writeStore
              : keyedStore,
    },
  } as unknown as PluginRuntime);
  const close = async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await state.cleanup();
  };
  return { keyedStore, handoffStore, writeStore, imageStore, store, close };
}

export const beamTestNow = Date.parse("2026-07-27T12:00:00.000Z");
const beamTestLogger = { warn: () => {}, info: () => {}, error: () => {} };
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
  sourceHomeId?: string;
  exportPolicy?: SessionCatalogHost["sessions"][number]["exportPolicy"] | null;
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
    hostId?: string;
    onList?: () => unknown;
    onRead?: (threadId: string, sourceHomeId?: string, agentId?: string) => unknown;
    processHomeFallbackAllowed?: boolean;
  } = {},
): PluginServiceExportCatalog {
  const id = params.id ?? "claude";
  const catalogHistory = new Map<string, BeamTestSession>();
  return {
    id,
    processHomeFallbackAllowed: params.processHomeFallbackAllowed ?? true,
    assertCurrent: () => {},
    list: async ({ source }) => {
      await params.onList?.();
      const visible = typeof params.sessions === "function" ? params.sessions() : params.sessions;
      for (const row of visible ?? []) {
        catalogHistory.set(row.threadId, row);
      }
      const known = source && catalogHistory.get(source.threadId);
      const sessions = source
        ? known &&
          source.hostId === (params.hostId ?? "gateway:local") &&
          known.sourceHomeId === source.sourceHomeId
          ? [known]
          : []
        : visible;
      return [
        {
          hostId: params.hostId ?? "gateway:local",
          label: "Local",
          kind: params.hostKind ?? "gateway",
          connected: true,
          ...(params.hostCursor ? { nextCursor: params.hostCursor } : {}),
          sessions: (sessions ?? [{ threadId: "t1", recencyAt: beamTestNow }]).map((session) => ({
            threadId: session.threadId,
            sourceHomeId: session.sourceHomeId,
            exportPolicy:
              session.exportPolicy === null
                ? undefined
                : (session.exportPolicy ?? {
                    origin: "native-local",
                    automatic: true,
                    stableHostThreadIdentity: true,
                  }),
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
    read: async ({ hostId, threadId, sourceHomeId, agentId }) => {
      await params.onRead?.(threadId, sourceHomeId, agentId);
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

// Existing network/retry cases exercise delivery against a deterministic cleaner fixture.
// Native child failures, redaction, raw-byte validation and bounds have separate contract tests.
const cleanBeamTestCandidate: typeof cleaner.cleanBeamCandidate = async (input) => {
  const candidate = JSON.parse(input) as cleaner.BeamCleanCandidate;
  const items = candidate.items.map(({ type, text }) => ({ type, text }));
  const packet = {
    version: 2 as const,
    beamId: "a".repeat(32),
    source: candidate.source,
    title: candidate.title,
    updatedAt: candidate.updatedAt,
    completed: candidate.completed,
    ...(candidate.sourceModel ? { sourceModel: candidate.sourceModel } : {}),
    ...(candidate.completeness === "partial" ? { truncated: true } : {}),
    items,
  };
  return { packet, raw: Buffer.from(JSON.stringify(packet)) };
};

type RunnerOptions = Parameters<typeof createBeamMirrorRunner>[0] & {
  listCatalogs?: () => PluginServiceExportCatalog[];
};
export function createBeamTestRunner({
  endpoint,
  listCatalogs = () => [createBeamTestCatalog()],
  resolveExecutable,
  ...options
}: Partial<RunnerOptions> & { endpoint?: string } = {}) {
  if (!resolveExecutable) {
    vi.spyOn(cleaner, "cleanBeamCandidate").mockImplementation(cleanBeamTestCandidate);
  }
  return createBeamMirrorRunner({
    catalogExports: { listCatalogs },
    resolveExecutable:
      resolveExecutable ??
      (async () => {
        throw new Error("unexpected test process");
      }),
    runtime: createBeamTestRuntime(beamTestMirrorConfig(endpoint ? { endpoint } : {})),
    logger: beamTestLogger,
    now: () => beamTestNow,
    signal: new AbortController().signal,
    ...options,
  });
}

export function createScheduledBeamTestRunner(options: Parameters<typeof createBeamTestRunner>[0]) {
  const scheduler = createTestPluginServiceScheduler();
  const runner = createBeamTestRunner({ ...options, signal: scheduler.signal });
  scheduler.schedule({ id: "mirror", delayMs: 0, everyMs: 30_000, run: () => runner.tick() });
  return { tick: () => vi.advanceTimersByTimeAsync(0), stop: scheduler.stop };
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
    vi.stubGlobal("fetch", fetchFn);
    return { logger, listCatalogs: () => [testCatalog], ...overrides };
  };
  return {
    sent,
    warnings,
    logger,
    runner: (...args: Parameters<typeof options>) => createBeamTestRunner(options(...args)),
  };
}
