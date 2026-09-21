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
const messages = new Set([LIST, PAGE]);
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

async function fixture(suffix = "default") {
  // The shared catalog harness owns this isolated directory and its cleanup.
  const root = fsSync.realpathSync(process.env.OPENCLAW_STATE_DIR!);
  const home = path.join(root, `private-catalog-home-${suffix}`);
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
  const control = createCodexSessionCatalogControlFactory({
    getPluginConfig: () => pluginConfig,
    getRuntimeConfig: () => config,
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
    control: control.forRequest("main", (await control.homesForAgent("main"))[0]),
    runtime,
    home,
    list: (search?: string) =>
      provider.list({ hostIds: [CODEX_LOCAL_SESSION_HOST_ID], ...(search ? { search } : {}) }),
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
  it("keeps background hydration context separate from list requests", async () => {
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
    const background = { traceId: "1".repeat(32), spanId: "1".repeat(16) };
    const caller = { traceId: "2".repeat(32), spanId: "2".repeat(16) };
    try {
      await ownerScope.run("background", () =>
        runWithDiagnosticTraceContext(background, () => f.control.initialize()),
      );
      const hosts = await ownerScope.run("caller", () =>
        runWithDiagnosticTraceContext(caller, () => f.list()),
      );
      expect(hosts[0]?.sessions).toEqual([expect.objectContaining({ threadId: "visible" })]);
      expect(sourceOwners).toEqual(["background", "background"]);
      const pages = await emitted(PAGE);
      expect(pages).toHaveLength(2);
      for (const page of pages) {
        expect(page.trace).toMatchObject(background);
        expect(fields(page)).not.toHaveProperty("listOperationId");
      }
      expect(await emitted(LIST)).toEqual([]);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
    } finally {
      ownerScope.disable();
    }
  });

  it("shares one cold hydration across four callers without logging session data", async () => {
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
    const pending = traces.map((trace) =>
      runWithDiagnosticTraceContext(trace, () => f.control.initialize()),
    );
    let settledLists = 0;
    const coldLists = traces.map((trace) =>
      runWithDiagnosticTraceContext(trace, () => f.list()).then((result) => {
        settledLists++;
        return result;
      }),
    );
    try {
      await started.promise;
      await nextTurn();
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
      expect(settledLists).toBe(0);
      clock += 1_500;
      response.resolve({ data: [thread] });
      await Promise.all(pending);
      const results = await Promise.all(coldLists);
      expect(results).toEqual(Array.from({ length: 4 }, () => results[0]));
      expect(results[0]?.[0]?.sessions).toEqual([
        expect.objectContaining({ threadId: thread.id, name: privateText, cwd: f.home }),
      ]);
      const pages = await emitted(PAGE);
      const lists = await emitted(LIST);
      expect(pages).toHaveLength(1);
      expect(lists).toHaveLength(4);
      for (const list of lists) {
        expect(fields(list)).toMatchObject({
          outcome: "resolved",
          elapsedMs: 1_500,
          controlPageCalls: 1,
          adoptionCalls: 1,
        });
      }
      for (const trace of traces) {
        expect(lists).toContainEqual(
          expect.objectContaining({ trace: expect.objectContaining(trace) }),
        );
      }
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
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
      expect(producer).not.toHaveProperty("listOperationId");
      expect(pages[0]?.trace).toMatchObject(traces[0]!);
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
      await Promise.allSettled([...pending, ...coldLists]);
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
      clock += 1_100;
      return [];
    });
    await f.control.initialize();
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
      elapsedMs: 1_100,
      controlPageCalls: 1,
      controlWaitSumMs: 0,
      adoptionCalls: 1,
      adoptionSumMs: 1_100,
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
    "records complete native hydration before resident %s filtering",
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
          for (let attempt = 1; attempt <= 6; attempt++) {
            options.controlObservation?.attemptWaiterFinished?.(
              waiterSummary({
                rpcId: (cursors.length - 1) * 6 + attempt,
                overloadAttemptOrdinal: attempt,
                waiterOutcome: attempt === 6 ? "resolved" : "native-error",
                wireOutcomeAtWaiterSettlement: attempt === 6 ? "native-ok" : "ingress-rejected",
              }),
            );
          }
          clock += 1_100;
          return {
            data: [thread],
            ...(cursors.length < 20 ? { nextCursor: `private-cursor-${cursors.length}` } : {}),
          };
        },
      );
      await f.control.initialize();
      const hosts = await f.list(kind === "title-filter" ? "wanted title" : undefined);
      expect(hosts[0]).toMatchObject({ connected: true, sessions: [] });
      expect(hosts[0]).not.toHaveProperty("nextCursor");
      expect(cursors).toEqual([
        undefined,
        ...Array.from({ length: 19 }, (_, i) => `private-cursor-${i + 1}`),
      ]);
      expect(await emitted(LIST)).toEqual([]);
      const pages = await emitted(PAGE);
      expect(pages).toHaveLength(20);
      for (const [index, page] of pages.entries()) {
        expect(fields(page)).toMatchObject({
          origin: "cold",
          controlRequestCalls: 1,
          inclusiveControlRequestWaitMs: 1_100,
          provenanceChecks: 1,
          provenanceReadCalls: index === 0 ? 1 : 0,
          provenanceCacheHits: index === 0 ? 0 : 1,
          controlWaitersOmitted: 2,
        });
        const tuples = JSON.parse(String(fields(page).controlWaitersV1));
        expect(tuples).toHaveLength(4);
        expect(tuples.map((tuple: unknown[]) => tuple[1])).toEqual([1, 2, 5, 6]);
        expect(Object.keys(fields(page)).length).toBeLessThanOrEqual(28);
        expect(Buffer.byteLength(JSON.stringify(fields(page)))).toBeLessThanOrEqual(2_048);
      }
      expect(JSON.stringify(records)).not.toContain("private-cursor-");
      expect(JSON.stringify(records)).not.toContain(privateText);
      await f.list("another query");
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(20);
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
    await f.control.initialize();
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

  it("attributes a slow warm list to adoption without starting another producer", async () => {
    const f = await fixture();
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [idleThread({ id: "resident-thread", source: "cli" })],
    });
    await f.control.initialize();
    const initial = await f.list();
    vi.mocked(f.runtime.agent.session.listSessionEntries).mockImplementation(() => {
      clock += 1_100;
      return [];
    });
    clock += 61_000;
    await expect(f.list()).resolves.toEqual(initial);
    expect(fields((await emitted(LIST))[0])).toMatchObject({
      elapsedMs: 1_100,
      controlWaitSumMs: 0,
      adoptionCalls: 1,
      adoptionSumMs: 1_100,
    });
    expect(await emitted(PAGE)).toEqual([]);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
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
      await f.control.initialize();
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

  it("bounds summaries and active observations without limiting background hydration", async () => {
    const response = createDeferred<unknown>();
    const allStarted = createDeferred<void>();
    let started = 0;
    commandRpcMocks.codexControlRequest.mockImplementation(() => {
      if (++started === 80) {
        allStarted.resolve();
      }
      return response.promise;
    });
    const calls: Promise<void>[] = [];
    try {
      for (let index = 0; index < 80; index++) {
        const f = await fixture(`cold-source-${index}`);
        calls.push(f.control.initialize());
      }
      await allStarted.promise;
      clock += 1_500;
      response.resolve({ data: [] });
      await Promise.all(calls);
      expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(80);
      await diagnosticRuntime.waitForDiagnosticEventsDrained();
      expect(records).toHaveLength(60);
      expect(records.some((record) => Number(fields(record).omittedObservations) >= 16)).toBe(true);
      records = [];
      clock += 61_000;
      commandRpcMocks.codexControlRequest.mockImplementation(async () => {
        clock += 1_100;
        return { data: [] };
      });
      const next = await fixture("after-capacity");
      await next.control.initialize();
      expect((await next.list())[0]?.connected).toBe(true);
      expect(await emitted(PAGE)).toHaveLength(1);
      expect(fields((await emitted(PAGE))[0])).toMatchObject({ omittedObservations: 4 });
      expect(await emitted(LIST)).toEqual([]);
    } finally {
      response.resolve({ data: [] });
      await Promise.allSettled(calls);
    }
  });

  it("records each hydration page's control phases and rejects late callbacks after settlement", async () => {
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
    await expect(f.control.initialize()).rejects.toThrow(privateText);
    const pages = await emitted(PAGE);
    expect(pages).toHaveLength(2);
    expect(fields(pages[0])).toMatchObject({
      outcome: "resolved",
      controlRequestCalls: 1,
      inclusiveControlRequestWaitMs: 1_051,
      controlLoadMs: 50,
      controlPrepareMs: 101,
      controlAcquireClientMs: 200,
      controlClientRequestMs: 600,
      controlReleaseClientMs: 100,
      postResponseMs: 0,
      provenanceReadCalls: 1,
      provenanceMs: 0,
      controlWaitersV1: JSON.stringify([
        [1, 1, clientInstanceId, 1, 1, "new", 10, 12, 11, 20, "resolved", "native-ok", 19],
      ]),
      controlWaitersOmitted: 0,
    });
    expect(fields(pages[1])).toMatchObject({
      outcome: "rejected",
      controlRequestCalls: 1,
      inclusiveControlRequestWaitMs: 2_000,
      controlLoadMs: 50,
      controlPrepareMs: 50,
      controlAcquireClientMs: 200,
      controlClientRequestMs: 600,
      controlReleaseClientMs: 100,
      provenanceReadCalls: 0,
      controlFailurePhase: "client-request",
      controlFailureCategory: "rpc-method-unavailable",
      controlWaitersV1: JSON.stringify([
        [1, 1, clientInstanceId, 2, 1, "new", 10, 12, 11, 20, "native-error", "native-error", 19],
      ]),
      controlWaitersOmitted: 0,
    });
    for (const page of pages) {
      expect(Object.keys(fields(page)).length).toBeLessThanOrEqual(28);
      expect(Buffer.byteLength(JSON.stringify(fields(page)))).toBeLessThanOrEqual(2_048);
    }
    expect(JSON.stringify(records)).not.toContain(privateText);
    const completed = JSON.stringify(pages);
    for (const observation of completedObservations) {
      observation.attemptWaiterFinished?.(waiterSummary({ rpcId: 100 }));
    }
    await diagnosticRuntime.waitForDiagnosticEventsDrained();
    expect(JSON.stringify(pages)).toBe(completed);
    expect(await emitted(PAGE)).toHaveLength(2);
  });

  it("preserves hydration errors and memory reads when the diagnostic sink throws", async () => {
    const f = await fixture();
    sink.throwing = true;
    const failure = new Error(privateText);
    commandRpcMocks.codexControlRequest.mockImplementation(async () => {
      clock += 1_500;
      throw failure;
    });
    await expect(f.control.initialize()).rejects.toBe(failure);
    const hosts = await f.list();
    expect(hosts[0]).toMatchObject({
      connected: false,
      sessions: [],
      error: {
        code: "APP_SERVER_UNAVAILABLE",
        message: "Codex app-server is unavailable on this host",
      },
    });
    expect(JSON.stringify(hosts)).not.toContain(privateText);
    expect(sink.attempts).toBeGreaterThanOrEqual(1);
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
  });
});
