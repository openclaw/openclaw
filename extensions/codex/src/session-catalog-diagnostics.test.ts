import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import * as diagnosticRuntime from "openclaw/plugin-sdk/diagnostic-runtime";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { runWithDiagnosticTraceContext } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resetLogger, setLoggerOverride } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodexControlRequestObservation,
  CodexRequestWaiterSummary,
} from "./app-server/request-observation.js";
import {
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_LOCAL_SESSION_HOST_ID,
  commandRpcMocks,
  createCodexSessionCatalogControlFactory,
  createCodexTestBindingStore,
  createGatewayApi,
  createRuntime,
  fs,
  fsSync,
  idleThread,
  path,
  registerCodexSessionCatalog,
  type OpenClawConfig,
} from "./session-catalog.test-helpers.js";

const sink = vi.hoisted(() => ({ throwing: false, attempts: 0 }));

vi.mock("openclaw/plugin-sdk/diagnostic-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/diagnostic-runtime")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => {
      const logger = actual.createSubsystemLogger(...args);
      if (args[0] !== "gateway/session-catalog") {
        return logger;
      }
      return {
        ...logger,
        warn(message: string, metadata?: Record<string, unknown>) {
          if (message.startsWith("slow Codex catalog ")) {
            sink.attempts++;
            if (sink.throwing) {
              throw new Error("synthetic catalog sink failure");
            }
          }
          logger.warn(message, metadata);
        },
      };
    },
  };
});

type LogRecord = Extract<DiagnosticEventPayload, { type: "log.record" }>;
const LIST = "slow Codex catalog list phases";
const PAGE = "slow Codex catalog page producer";
const WAIT = "slow Codex catalog cache wait";
const messages = new Set([LIST, PAGE, WAIT]);
const privateText = "synthetic-private-catalog-content";
const clientInstanceId = "11111111-1111-4111-8111-111111111111";
let clock = 0;
let records: LogRecord[] = [];
let unsubscribe = () => {};

beforeEach(() => {
  diagnosticRuntime.resetDiagnosticEventsForTest();
  clock += 61_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  sink.throwing = false;
  sink.attempts = 0;
  records = [];
  vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
  setLoggerOverride({ level: "warn", consoleLevel: "silent" });
  unsubscribe = diagnosticRuntime.onInternalDiagnosticEvent((event) => {
    if (event.type === "log.record" && messages.has(event.message)) {
      records.push(event);
    }
  });
});

afterEach(async () => {
  await diagnosticRuntime.waitForDiagnosticEventsDrained();
  unsubscribe();
  resetLogger();
  vi.restoreAllMocks();
  diagnosticRuntime.resetDiagnosticEventsForTest();
});

async function emitted(message: string) {
  await diagnosticRuntime.waitForDiagnosticEventsDrained();
  return records.filter((record) => record.message === message);
}

function fields(record: LogRecord | undefined) {
  if (!record) {
    throw new Error("expected catalog diagnostic record");
  }
  return record.attributes ?? {};
}

function waiterSummary(
  overrides: Partial<CodexRequestWaiterSummary> = {},
): CodexRequestWaiterSummary {
  return {
    clientInstanceId,
    rpcId: 1,
    waiterOrdinal: 1,
    disposition: "new",
    overloadAttemptOrdinal: 1,
    attemptCreatedAtMs: 10,
    firstPossibleWriteAtMs: 12,
    waiterAttachedAtMs: 11,
    waiterSettledAtMs: 20,
    waiterOutcome: "resolved",
    wireOutcomeAtWaiterSettlement: "native-ok",
    wireObservedAtMs: 19,
    ...overrides,
  };
}

async function fixture() {
  // The shared catalog harness owns this isolated directory and its cleanup.
  const root = fsSync.realpathSync(process.env.OPENCLAW_STATE_DIR!);
  const home = path.join(root, "private-catalog-home");
  const agentDir = path.join(root, "agent");
  await fs.mkdir(path.join(home, "sessions"), { recursive: true });
  await fs.mkdir(agentDir, { recursive: true });
  vi.stubEnv("CODEX_HOME", home);
  vi.stubEnv("PATH", "");
  const config: OpenClawConfig = {
    agents: { list: [{ id: "main", default: true, agentDir }] },
  };
  const pluginConfig = {
    supervision: { enabled: true },
    appServer: { command: "catalog-fixture", homeScope: "user" },
  };
  let cacheNow = 1_000;
  const control = createCodexSessionCatalogControlFactory({
    getPluginConfig: () => pluginConfig,
    getRuntimeConfig: () => config,
    now: () => cacheNow,
  });
  const { runtime } = createRuntime();
  const { api, getProvider } = createGatewayApi(runtime, config);
  registerCodexSessionCatalog({
    api,
    bindingStore: createCodexTestBindingStore(),
    control,
    getPluginConfig: () => pluginConfig,
    getRuntimeConfig: () => config,
  });
  const provider = getProvider();
  if (!provider) {
    throw new Error("catalog provider was not registered");
  }
  return {
    provider,
    runtime,
    home,
    list: (search?: string) =>
      provider.list({ hostIds: [CODEX_LOCAL_SESSION_HOST_ID], ...(search ? { search } : {}) }),
    expire: () => {
      cacheNow += 32_001;
    },
    async thread(originator: "openclaw" | "codex") {
      const threadId = `${privateText}-${originator}`;
      const rollout = path.join(home, "sessions", "private-rollout.jsonl");
      await fs.writeFile(
        rollout,
        `${JSON.stringify({ type: "session_meta", payload: { id: threadId, originator } })}\n`,
      );
      return idleThread({
        id: threadId,
        name: privateText,
        source: "cli",
        path: rollout,
        cwd: home,
      });
    },
  };
}

describe("registered Codex catalog diagnostics", () => {
  it("retains the first step's full context and finishes one logical observation at close", async () => {
    const f = await fixture();
    const managed = await f.thread("openclaw");
    const ownerScope = new AsyncLocalStorage<string>();
    const sourceOwners: Array<string | undefined> = [];
    commandRpcMocks.codexControlRequest.mockImplementation(async (_config, method, params) => {
      expect(method).toBe("thread/list");
      sourceOwners.push(ownerScope.getStore());
      clock += 1_100;
      return params.cursor
        ? { data: [idleThread({ id: "visible", source: "cli" })] }
        : { data: [managed], nextCursor: "next" };
    });
    const original = { traceId: "1".repeat(32), spanId: "1".repeat(16) };
    const unrelated = { traceId: "2".repeat(32), spanId: "2".repeat(16) };
    const createOperation = f.provider.createListOperation;
    if (!createOperation) {
      throw new Error("Codex list operation is unavailable");
    }
    const operation = ownerScope.run("factory", () =>
      runWithDiagnosticTraceContext(unrelated, () =>
        createOperation({
          agentId: "main",
          hostIds: [CODEX_LOCAL_SESSION_HOST_ID],
          limitPerHost: 1,
        }),
      ),
    );
    try {
      clock += 5_000;
      expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
      expect(await emitted(LIST)).toEqual([]);
      await expect(
        ownerScope.run("original", () =>
          runWithDiagnosticTraceContext(original, () => operation.next()),
        ),
      ).resolves.toEqual({ done: false });
      const firstPage = (await emitted(PAGE))[0];
      expect(firstPage?.trace).toMatchObject(original);
      expect(await emitted(LIST)).toEqual([]);

      clock += 700;
      await expect(
        ownerScope.run("unrelated", () =>
          runWithDiagnosticTraceContext(unrelated, () => operation.next()),
        ),
      ).resolves.toMatchObject({ done: true, hosts: [{ sessions: [{ threadId: "visible" }] }] });
      expect(sourceOwners).toEqual(["original", "original"]);
      expect(await emitted(LIST)).toEqual([]);
      ownerScope.run("unrelated", () =>
        runWithDiagnosticTraceContext(unrelated, () => operation.close()),
      );
      const lists = await emitted(LIST);
      expect(lists).toHaveLength(1);
      expect(lists[0]?.trace).toMatchObject(original);
      expect(fields(lists[0])).toMatchObject({
        outcome: "resolved",
        elapsedMs: 2_900,
        controlPageCalls: 2,
        controlWaitSumMs: 2_200,
      });
      const pages = await emitted(PAGE);
      expect(pages).toHaveLength(2);
      expect(pages.map((record) => fields(record).listOperationId)).toEqual([
        fields(lists[0]).operationId,
        fields(lists[0]).operationId,
      ]);
      operation.close();
      await expect(operation.next()).rejects.toThrow();
      expect(await emitted(LIST)).toHaveLength(1);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
    } finally {
      operation.close();
      ownerScope.disable();
    }
  });

  it("links four cold callers to one producer and three waited joins without logging session data", async () => {
    const f = await fixture();
    const thread = await f.thread("codex");
    const response = createDeferred<unknown>();
    const started = createDeferred<void>();
    commandRpcMocks.codexControlRequest.mockImplementation(
      async (
        _config: unknown,
        _method: unknown,
        _params: unknown,
        options: { controlObservation?: CodexControlRequestObservation },
      ) => {
        started.resolve();
        const result = await response.promise;
        options.controlObservation?.attemptWaiterFinished?.(waiterSummary());
        return result;
      },
    );
    const traces = Array.from({ length: 4 }, (_, index) => ({
      traceId: String(index + 1).repeat(32),
      spanId: String(index + 1).repeat(16),
    }));
    const pending = traces.map((trace) => runWithDiagnosticTraceContext(trace, () => f.list()));
    try {
      await started.promise;
      await nextTurn();
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
      clock += 1_500;
      response.resolve({ data: [thread] });
      const results = await Promise.all(pending);
      expect(results).toEqual(Array.from({ length: 4 }, () => results[0]));
      expect(results[0]?.[0]?.sessions).toEqual([
        expect.objectContaining({ threadId: thread.id, name: privateText, cwd: f.home }),
      ]);
      const pages = await emitted(PAGE);
      const lists = await emitted(LIST);
      const waits = await emitted(WAIT);
      expect(pages).toHaveLength(1);
      expect(lists).toHaveLength(4);
      expect(waits).toHaveLength(3);
      const producer = fields(pages[0]);
      expect(producer).not.toHaveProperty("controlFailurePhase");
      expect(producer).not.toHaveProperty("controlFailureCategory");
      expect(producer).toMatchObject({
        outcome: "resolved",
        origin: "cold",
        controlRequestCalls: 1,
        inclusiveControlRequestWaitMs: 1_500,
        inclusiveControlRequestWaitMaxMs: 1_500,
        provenanceChecks: 1,
        provenanceReadCalls: 1,
        provenanceCacheHits: 0,
        controlWaitersV1: JSON.stringify([
          [1, 1, clientInstanceId, 1, 1, "new", 10, 12, 11, 20, "resolved", "native-ok", 19],
        ]),
        controlWaitersOmitted: 0,
      });
      const owner = lists.find((record) => fields(record).coldStarts === 1);
      expect(owner?.trace).toMatchObject(traces[0]!);
      expect(producer.listOperationId).toBe(fields(owner).operationId);
      expect(pages[0]?.trace).toMatchObject(traces[0]!);
      expect(new Set(lists.map((record) => fields(record).operationId)).size).toBe(4);
      for (const waiter of waits) {
        const wait = fields(waiter);
        expect(wait).toMatchObject({
          outcome: "resolved",
          elapsedMs: 1_500,
          producerOperationId: producer.operationId,
          producerObserved: true,
        });
        const caller = lists.find((record) => fields(record).operationId === wait.listOperationId);
        expect(fields(caller).pendingJoins).toBe(1);
        expect(waiter.trace).toEqual(caller?.trace);
      }
      expect(new Set(records.map((record) => fields(record).diagnosticEpoch)).size).toBe(1);
      expect(JSON.stringify(records)).not.toContain(privateText);
      expect(JSON.stringify(records)).not.toContain(f.home);
      for (const record of records) {
        expect(Object.keys(fields(record)).length).toBeLessThanOrEqual(28);
        expect(Buffer.byteLength(JSON.stringify(fields(record)))).toBeLessThanOrEqual(2_048);
        expect(
          Object.values(fields(record)).every((value) =>
            ["string", "number", "boolean"].includes(typeof value),
          ),
        ).toBe(true);
        const controlWaitersV1 = fields(record).controlWaitersV1;
        if (controlWaitersV1 !== undefined) {
          expect(controlWaitersV1).toBeTypeOf("string");
          if (typeof controlWaitersV1 !== "string") {
            throw new Error("expected JSON-encoded waiter tuples");
          }
          const tuples: unknown = JSON.parse(controlWaitersV1);
          expect(Array.isArray(tuples)).toBe(true);
          if (!Array.isArray(tuples)) {
            throw new Error("expected bounded waiter tuples");
          }
          expect(tuples.length).toBeLessThanOrEqual(4);
          for (const tuple of tuples) {
            expect(Array.isArray(tuple)).toBe(true);
            if (!Array.isArray(tuple)) {
              throw new Error("expected a waiter tuple");
            }
            expect(tuple).toHaveLength(13);
            expect(
              tuple.every((value) => value === null || ["string", "number"].includes(typeof value)),
            ).toBe(true);
          }
        }
      }
    } finally {
      response.resolve({ data: [] });
      await Promise.allSettled(pending);
    }
  });

  it("separates inclusive control waiting from adoption and leaves an absent snapshot unobserved", async () => {
    const f = await fixture();
    const thread = await f.thread("codex");
    commandRpcMocks.codexControlRequest.mockImplementation(async () => {
      clock += 1_200;
      return { data: [thread] };
    });
    vi.mocked(f.runtime.agent.session.listSessionEntries).mockImplementation(() => {
      clock += 400;
      return [];
    });
    const hosts = await f.list();
    expect(hosts[0]?.sessions[0]?.threadId).toBe(thread.id);
    expect(fields((await emitted(PAGE))[0])).toMatchObject({
      controlRequestCalls: 1,
      inclusiveControlRequestWaitMs: 1_200,
      inclusiveControlRequestWaitMaxMs: 1_200,
      postResponseMs: 0,
      provenanceChecks: 1,
      provenanceReadCalls: 1,
      provenanceMs: 0,
    });
    const list = fields((await emitted(LIST))[0]);
    expect(list).toMatchObject({
      elapsedMs: 1_600,
      controlPageCalls: 1,
      controlWaitSumMs: 1_200,
      adoptionCalls: 1,
      adoptionSumMs: 400,
    });
    expect(list).not.toHaveProperty("managedSnapshotMs");
    expect(commandRpcMocks.codexControlRequest.mock.calls[0]?.[3]).toMatchObject({
      authProfileId: null,
    });
    expect(commandRpcMocks.codexControlRequest.mock.calls[0]?.[3]).not.toHaveProperty("onResponse");
    expect(commandRpcMocks.codexControlRequest.mock.calls[0]?.[3]).not.toHaveProperty(
      "beforeRequest",
    );
  });

  it.each(["exclusion", "title-filter"] as const)(
    "distinguishes twenty %s pages without calling them native storage pages",
    async (kind) => {
      const f = await fixture();
      const thread = await f.thread(kind === "exclusion" ? "openclaw" : "codex");
      const cursors: (string | undefined)[] = [];
      commandRpcMocks.codexControlRequest.mockImplementation(
        async (
          _config: unknown,
          method: unknown,
          params: { cursor?: string },
          options: { controlObservation?: CodexControlRequestObservation },
        ) => {
          expect(method).toBe("thread/list");
          expect(params).not.toHaveProperty("searchTerm");
          cursors.push(params.cursor);
          for (let attempt = 1; attempt <= 4; attempt++) {
            options.controlObservation?.attemptWaiterFinished?.(
              waiterSummary({
                rpcId: (cursors.length - 1) * 4 + attempt,
                overloadAttemptOrdinal: attempt,
                waiterOutcome: attempt === 4 ? "resolved" : "native-error",
                wireOutcomeAtWaiterSettlement: attempt === 4 ? "native-ok" : "ingress-rejected",
              }),
            );
          }
          clock += 100;
          return { data: [thread], nextCursor: `private-cursor-${cursors.length}` };
        },
      );
      const hosts = await f.list(kind === "title-filter" ? "wanted title" : undefined);
      expect(hosts[0]).toMatchObject({
        connected: true,
        sessions: [],
        nextCursor: "private-cursor-20",
      });
      expect(cursors).toEqual([
        undefined,
        ...Array.from({ length: 19 }, (_, i) => `private-cursor-${i + 1}`),
      ]);
      const list = fields((await emitted(LIST))[0]);
      expect(list).toMatchObject({
        controlPageCalls: kind === "exclusion" ? 20 : 1,
        controlWaitSumMs: 2_000,
        coldStarts: kind === "exclusion" ? 20 : 1,
        exclusionMarkCalls: 0,
      });
      const pages = await emitted(PAGE);
      if (kind === "title-filter") {
        expect(pages).toHaveLength(1);
        expect(fields(pages[0])).toMatchObject({
          controlRequestCalls: 20,
          inclusiveControlRequestWaitMs: 2_000,
          inclusiveControlRequestWaitMaxMs: 100,
          provenanceChecks: 20,
          provenanceReadCalls: 1,
          provenanceCacheHits: 19,
          stopReason: "page-bound",
          controlWaitersV1: JSON.stringify([
            [
              1,
              1,
              clientInstanceId,
              1,
              1,
              "new",
              10,
              12,
              11,
              20,
              "native-error",
              "ingress-rejected",
              19,
            ],
            [
              1,
              2,
              clientInstanceId,
              2,
              1,
              "new",
              10,
              12,
              11,
              20,
              "native-error",
              "ingress-rejected",
              19,
            ],
            [
              20,
              3,
              clientInstanceId,
              79,
              1,
              "new",
              10,
              12,
              11,
              20,
              "native-error",
              "ingress-rejected",
              19,
            ],
            [20, 4, clientInstanceId, 80, 1, "new", 10, 12, 11, 20, "resolved", "native-ok", 19],
          ]),
          controlWaitersOmitted: 76,
        });
        expect(Object.keys(fields(pages[0])).length).toBeLessThanOrEqual(28);
        expect(Buffer.byteLength(JSON.stringify(fields(pages[0])))).toBeLessThanOrEqual(2_048);
      } else {
        expect(pages).toHaveLength(0);
      }
      expect(JSON.stringify(records)).not.toContain("private-cursor-");
      expect(JSON.stringify(records)).not.toContain(privateText);
    },
  );

  it("preserves a bounded page warning with maximal waiter values and omitted invalid facts", async () => {
    const f = await fixture();
    const maximum = Number.MAX_SAFE_INTEGER;
    commandRpcMocks.codexControlRequest.mockImplementation(
      async (
        _config: unknown,
        _method: unknown,
        _params: unknown,
        options: { controlObservation?: CodexControlRequestObservation },
      ) => {
        const observation = options.controlObservation;
        observation?.attemptWaiterFinished?.(waiterSummary({ clientInstanceId: privateText }));
        for (let index = 0; index < 4; index++) {
          observation?.attemptWaiterFinished?.(
            waiterSummary({
              rpcId: maximum - index,
              waiterOrdinal: maximum,
              overloadAttemptOrdinal: maximum,
              disposition: "joined",
              attemptCreatedAtMs: maximum,
              firstPossibleWriteAtMs: maximum,
              waiterAttachedAtMs: maximum,
              waiterSettledAtMs: maximum,
              waiterOutcome: "authority-rejected",
              wireOutcomeAtWaiterSettlement: "ingress-rejected",
              wireObservedAtMs: maximum,
            }),
          );
        }
        clock += 1_100;
        return { data: [] };
      },
    );
    expect((await f.list())[0]).toMatchObject({ connected: true, sessions: [] });
    const pages = await emitted(PAGE);
    expect(pages).toHaveLength(1);
    const metadata = fields(pages[0]);
    expect(metadata).toMatchObject({
      outcome: "resolved",
      origin: "cold",
      controlRequestCalls: 1,
      inclusiveControlRequestWaitMs: 1_100,
      inclusiveControlRequestWaitMaxMs: 1_100,
      controlWaitersV1: JSON.stringify(
        Array.from({ length: 4 }, (_, index) => [
          1,
          maximum,
          clientInstanceId,
          maximum - index,
          maximum,
          "joined",
          maximum,
          maximum,
          maximum,
          maximum,
          "authority-rejected",
          "ingress-rejected",
          maximum,
        ]),
      ),
      controlWaitersOmitted: 1,
      omittedObservations: 0,
    });
    expect(Object.keys(metadata).length).toBeLessThanOrEqual(28);
    expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThanOrEqual(2_048);
    expect(JSON.stringify(records)).not.toContain(privateText);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
  });

  it("counts stale delivery and refresh creation independently while pending refresh readers stay immediate", async () => {
    const f = await fixture();
    const oldThread = idleThread({ id: "old-thread", source: "cli" });
    commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [oldThread] });
    const initial = await f.list();
    vi.mocked(f.runtime.agent.session.listSessionEntries).mockImplementation(() => {
      clock += 1_100;
      return [];
    });
    await expect(f.list()).resolves.toEqual(initial);
    expect(fields((await emitted(LIST))[0])).toMatchObject({ freshHits: 1, coldStarts: 0 });
    f.expire();
    const refresh = createDeferred<unknown>();
    const started = createDeferred<void>();
    commandRpcMocks.codexControlRequest.mockImplementationOnce(() => {
      started.resolve();
      return refresh.promise;
    });
    try {
      await expect(f.list()).resolves.toEqual(initial);
      await started.promise;
      await expect(f.list()).resolves.toEqual(initial);
      const lists = await emitted(LIST);
      expect(fields(lists[1])).toMatchObject({ staleHits: 1, refreshStarts: 1, pendingJoins: 0 });
      expect(fields(lists[2])).toMatchObject({ staleHits: 1, refreshStarts: 0, pendingJoins: 0 });
      expect(await emitted(WAIT)).toHaveLength(0);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
      clock += 1_500;
      refresh.resolve({ data: [idleThread({ id: "new-thread", source: "cli" })] });
      await nextTurn();
      expect((await f.list())[0]?.sessions[0]?.threadId).toBe("new-thread");
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
      const refreshed = (await emitted(PAGE)).find((record) => fields(record).origin === "refresh");
      expect(fields(refreshed).listOperationId).toBe(fields(lists[1]).operationId);
    } finally {
      refresh.resolve({ data: [] });
      await nextTurn();
    }
  });

  it.each(["disabled", "disabled-during-call", "below-threshold"] as const)(
    "keeps %s diagnostics silent without changing the result",
    async (mode) => {
      const f = await fixture();
      const gate =
        mode === "below-threshold"
          ? undefined
          : vi
              .spyOn(diagnosticRuntime, "areDiagnosticsEnabledForProcess")
              .mockReturnValue(mode !== "disabled");
      commandRpcMocks.codexControlRequest.mockImplementation(async () => {
        clock += mode === "below-threshold" ? 999 : 1_500;
        if (mode === "disabled-during-call") {
          gate?.mockReturnValue(false);
        }
        return { data: [idleThread({ name: privateText, source: "cli" })] };
      });
      expect((await f.list())[0]?.sessions[0]?.name).toBe(privateText);
      await diagnosticRuntime.waitForDiagnosticEventsDrained();
      expect(records).toEqual([]);
      expect(sink.attempts).toBe(0);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
      if (mode === "disabled") {
        expect(commandRpcMocks.codexControlRequest.mock.calls[0]?.[3]).not.toHaveProperty(
          "controlObservation",
        );
      }
    },
  );

  it("separates node inventory and paired-node waits without issuing local requests", async () => {
    const f = await fixture();
    vi.mocked(f.runtime.nodes.list).mockImplementation(async () => {
      clock += 1_200;
      return {
        nodes: [
          {
            nodeId: privateText,
            connected: true,
            commands: [CODEX_APP_SERVER_THREADS_LIST_COMMAND],
          },
        ],
      };
    });
    vi.mocked(f.runtime.nodes.invoke).mockImplementation(async () => {
      clock += 400;
      return { payloadJSON: JSON.stringify({ sessions: [] }) };
    });
    const hosts = await f.provider.list({ hostIds: [`node:${privateText}`] });
    expect(hosts).toEqual([expect.objectContaining({ connected: true, sessions: [] })]);
    expect(fields((await emitted(LIST))[0])).toMatchObject({
      elapsedMs: 1_600,
      localHostCount: 0,
      controlPageCalls: 0,
      nodeRegistryCalls: 1,
      nodeRegistryMs: 1_200,
      pairedNodeCalls: 1,
      pairedNodeSettled: 1,
      nodeWaitSumMs: 400,
    });
    expect(f.runtime.nodes.list).toHaveBeenCalledOnce();
    expect(f.runtime.nodes.invoke).toHaveBeenCalledOnce();
    expect(commandRpcMocks.codexControlRequest).not.toHaveBeenCalled();
    expect(await emitted(PAGE)).toEqual([]);
    expect(JSON.stringify(records)).not.toContain(privateText);
  });

  it("limits emitted summaries without throttling catalog requests and reports suppression", async () => {
    const f = await fixture();
    commandRpcMocks.codexControlRequest.mockImplementation(async () => {
      clock += 1_100;
      return { data: [] };
    });
    for (let index = 0; index < 32; index++) {
      f.expire();
      expect((await f.list(`query-${index}`))[0]?.connected).toBe(true);
    }
    await diagnosticRuntime.waitForDiagnosticEventsDrained();
    expect(records).toHaveLength(60);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(32);
    clock += 61_000;
    f.expire();
    await f.list("after-window");
    expect(fields((await emitted(PAGE)).at(-1))).toMatchObject({ omittedObservations: 4 });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(33);
  });

  it("keeps requests running when diagnostic capacity is full and releases settled observations", async () => {
    const f = await fixture();
    const response = createDeferred<unknown>();
    const started = createDeferred<void>();
    commandRpcMocks.codexControlRequest.mockImplementation(() => {
      started.resolve();
      return response.promise;
    });
    const calls = Array.from({ length: 40 }, () => f.list());
    try {
      await started.promise;
      await nextTurn();
      clock += 1_500;
      response.resolve({ data: [] });
      const results = await Promise.all(calls);
      expect(results.every((hosts) => hosts[0]?.connected)).toBe(true);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
      await diagnosticRuntime.waitForDiagnosticEventsDrained();
      expect(records.length).toBeLessThanOrEqual(60);
      expect(records.some((record) => Number(fields(record).omittedObservations) >= 16)).toBe(true);
      records = [];
      clock += 61_000;
      commandRpcMocks.codexControlRequest.mockImplementation(async () => {
        clock += 1_100;
        return { data: [] };
      });
      f.expire();
      await f.list("after-capacity");
      expect(await emitted(PAGE)).toHaveLength(1);
      expect(await emitted(LIST)).toHaveLength(1);
    } finally {
      response.resolve({ data: [] });
      await Promise.allSettled(calls);
    }
  });

  it("sums repeated control phases and retires each call before late callbacks or page completion", async () => {
    const f = await fixture();
    const thread = await f.thread("codex");
    let previous: CodexControlRequestObservation | undefined;
    const completedObservations: CodexControlRequestObservation[] = [];
    commandRpcMocks.codexControlRequest.mockImplementation(
      async (
        _pluginConfig: unknown,
        _method: unknown,
        _params: unknown,
        options: { controlObservation?: CodexControlRequestObservation },
      ) => {
        const observation = options.controlObservation;
        if (!observation) {
          throw new Error("expected the active control observation");
        }
        completedObservations.push(observation);
        if (!previous) {
          clock += 50;
          observation.phase("prepare");
          for (let attempt = 0; attempt < 2; attempt++) {
            clock += 25.25;
            observation.phase("acquire-client");
            clock += 100;
            observation.phase("prepare");
            clock += 25.25;
            observation.phase("client-request");
            clock += 300;
            observation.phase("release-client");
            clock += 50;
            if (attempt === 0) {
              observation.phase("prepare");
            }
          }
          observation.attemptWaiterFinished?.(waiterSummary());
          previous = observation;
          return { data: [thread], nextCursor: "next" };
        }
        expect(observation).not.toBe(previous);
        clock += 50;
        observation.phase("prepare");
        clock += 50;
        observation.phase("acquire-client");
        clock += 200;
        observation.phase("client-request");
        clock += 600;
        observation.phase("release-client");
        clock += 100;
        observation.attemptWaiterFinished?.(
          waiterSummary({
            rpcId: 2,
            waiterOutcome: "native-error",
            wireOutcomeAtWaiterSettlement: "native-error",
          }),
        );
        observation.failed({ phase: "client-request", category: "rpc-method-unavailable" });
        clock += 1_000;
        previous.phase("prepare");
        previous.failed({ phase: "release-client", category: "other" });
        previous.attemptWaiterFinished?.(waiterSummary({ rpcId: 99 }));
        observation.phase("release-client");
        observation.failed({ phase: "release-client", category: "deadline-observed" });
        throw new Error(privateText);
      },
    );
    const hosts = await f.list(privateText);
    expect(hosts[0]).toMatchObject({
      connected: false,
      sessions: [],
      error: {
        code: "APP_SERVER_UNAVAILABLE",
        message: "Codex app-server is unavailable on this host",
      },
    });
    const pages = await emitted(PAGE);
    expect(pages).toHaveLength(1);
    expect(fields(pages[0])).toMatchObject({
      outcome: "rejected",
      controlRequestCalls: 2,
      inclusiveControlRequestWaitMs: 3_051,
      controlLoadMs: 100,
      controlPrepareMs: 151,
      controlAcquireClientMs: 400,
      controlClientRequestMs: 1_200,
      controlReleaseClientMs: 200,
      postResponseMs: 0,
      provenanceReadCalls: 1,
      provenanceMs: 0,
      controlFailurePhase: "client-request",
      controlFailureCategory: "rpc-method-unavailable",
      controlWaitersV1: JSON.stringify([
        [1, 1, clientInstanceId, 1, 1, "new", 10, 12, 11, 20, "resolved", "native-ok", 19],
        [2, 1, clientInstanceId, 2, 1, "new", 10, 12, 11, 20, "native-error", "native-error", 19],
      ]),
      controlWaitersOmitted: 0,
    });
    expect(Object.keys(fields(pages[0])).length).toBeLessThanOrEqual(28);
    expect(Buffer.byteLength(JSON.stringify(fields(pages[0])))).toBeLessThanOrEqual(2_048);
    expect(JSON.stringify({ hosts, records })).not.toContain(privateText);
    const completed = JSON.stringify(pages[0]);
    for (const observation of completedObservations) {
      observation.attemptWaiterFinished?.(waiterSummary({ rpcId: 100 }));
    }
    await diagnosticRuntime.waitForDiagnosticEventsDrained();
    expect(JSON.stringify(pages[0])).toBe(completed);
    expect(await emitted(PAGE)).toHaveLength(1);
  });

  it("preserves the provider's error host when the diagnostic sink throws", async () => {
    const f = await fixture();
    sink.throwing = true;
    commandRpcMocks.codexControlRequest.mockImplementation(async () => {
      clock += 1_500;
      throw new Error(privateText);
    });
    const hosts = await f.list();
    expect(hosts[0]).toMatchObject({
      connected: false,
      sessions: [],
      error: { code: "APP_SERVER_UNAVAILABLE" },
    });
    expect(hosts[0]?.error?.message).toBe("Codex app-server is unavailable on this host");
    expect(JSON.stringify(hosts)).not.toContain(privateText);
    expect(sink.attempts).toBeGreaterThanOrEqual(2);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
  });
});
