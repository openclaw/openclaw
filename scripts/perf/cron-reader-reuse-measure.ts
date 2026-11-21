/**
 * Real compiled cron reads over synthetic SQLite state; no source loader or profiler.
 * node scripts/perf/cron-reader-reuse-measure.ts --build-root /path/to/build \
 *   --state-dir /platform/temp/fixture --jobs 40 --phase prepare
 * Copy the closed fixture, then run --phase measure in a fresh process for each arm.
 * Sizes: 40/1000 jobs. One cold cycle, ten warm-process cycles, five seconds of
 * natural idle after each phase. Doctor uses a fresh worker for each inventory.
 * Operation clocks exclude verification; phase/total clocks include it. Export
 * resolution and bundle hashing run only in preparation. The controller binds
 * the prepared export metadata and expected corpus before each measured child.
 * RSS/process CPU include this process and its threads, not broker/copy processes.
 * The controller owns deadlines, descendant checks and fixture removal.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type * as Projection from "../../src/cron/run-history-detail.js";
import type * as Store from "../../src/cron/store.js";
import type * as Reads from "../../src/cron/store/read-only.js";
import type * as History from "../../src/cron/store/run-history.js";
import type {
  CronJsonValue,
  CronRunHistoryWrite,
  CronRunRecord,
} from "../../src/cron/store/run-history.types.js";
import type { CronStoredJob } from "../../src/cron/types.js";
import type * as Roles from "../../src/infra/database-engine/admission-scope.js";
import type * as Diagnostics from "../../src/infra/worker-cpu.js";
import type * as Native from "../../src/infra/worker-native-lifecycle.js";
import type * as Singletons from "../../src/shared/global-singleton.js";
import type * as State from "../../src/state/openclaw-state-db-cache.js";

const STORE_KEY = "cron-reader-benchmark";
const WARM_CYCLES = 10;
const IDLE_MS = 5000;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const lexical = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

// Match JSON storage/transport normalization; retain every returned field and
// array order. Sorting object keys makes equality independent of property order.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => lexical(a, b)))
      : item,
  );
}
function clock() {
  return { atMs: performance.now(), cpu: process.cpuUsage(), main: process.threadCpuUsage() };
}
function elapsed(start: ReturnType<typeof clock>) {
  const wallMs = performance.now() - start.atMs;
  const cpu = process.cpuUsage(start.cpu);
  const mainCpu = process.threadCpuUsage(start.main);
  return {
    wallMs,
    processCpuMs: (cpu.user + cpu.system) / 1000,
    mainCpuMs: (mainCpu.user + mainCpu.system) / 1000,
  };
}
type Timing = ReturnType<typeof elapsed>;
type BuiltExport = { file: string; alias: string; sha256: string };
type Oracle = { selected: string; inventory: string; history: string; projection: string };
type FixtureReceipt = {
  version: 1;
  jobs: number;
  taskIds: string[];
  runIds: string[];
  oracle: Oracle;
  modules: Record<string, BuiltExport>;
  worker: { entry: string; sha256: string };
};

function fixture(jobs: number) {
  const outcomes = ["progress", "done", "blocked", "needs_attention"] as const;
  const access = ["standard", "daybreak_blue", "daybreak_red"] as const;
  const rows: CronStoredJob[] = Array.from({ length: jobs }, (_, index) => ({
    id: `synthetic-${String(index).padStart(4, "0")}`,
    name: `Synthetic scheduled job ${index}`,
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: `Review synthetic queue ${index}.` },
    delivery: { mode: "none" },
    cyberAccessProgram: access[index % access.length]!,
    state: {
      nextRunAtMs: 60_001,
      lastMeaningfulResult: {
        outcome: outcomes[index % outcomes.length]!,
        summary: `Persisted result ${index}.`,
        atMs: index,
      },
    },
  }));
  const definitions = rows.map(({ updatedAtMs: _updated, state: _state, ...job }) =>
    Object.assign({}, job, {
      payload: { ...job.payload, kind: "accessAgentTurn" },
      state: {},
    }),
  );
  function historyResult(index: number): CronJsonValue {
    if (index % 5 === 0) {
      return { outcome: "no_change" };
    }
    return { outcome: outcomes[index % outcomes.length]!, summary: `  Result ${index}.  ` };
  }
  const writes = rows.map<CronRunHistoryWrite>((job, index) => ({
    storeKey: STORE_KEY,
    jobId: job.id,
    runId: `run-${job.id}`,
    agentId: "main",
    startedAt: 1_000_000 + index * 100,
    endedAt: 1_000_010 + index * 100,
    sessionKey: `agent:main:cron:${job.id}`,
    status: "succeeded",
    summary: `History summary ${index}.`,
    detail: {
      kind: "cron-run",
      storeKey: STORE_KEY,
      status: "ok",
      completionStatus: "succeeded",
      result: historyResult(index),
      runAtMs: 1_000_000 + index * 100,
      durationMs: 10,
      runId: `run-${job.id}`,
      sessionId: `session-${index}`,
    },
  }));
  const history = writes.map((run) => ({
    id: run.runId,
    jobId: run.jobId,
    runId: run.runId,
    agentId: run.agentId,
    sessionKey: run.sessionKey,
    createdAt: run.startedAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    lastEventAt: run.endedAt,
    status: run.status,
    summary: run.summary,
    detail: run.detail,
  }));
  const projection = writes.map((run, index) => ({
    ts: run.endedAt,
    jobId: run.jobId,
    action: "finished",
    status: "ok",
    completionStatus: "succeeded",
    summary: run.summary,
    result:
      index % 5 === 0
        ? { outcome: "no_change" }
        : { outcome: outcomes[index % outcomes.length]!, summary: `Result ${index}.` },
    runId: run.runId,
    runAtMs: run.startedAt,
    durationMs: 10,
    sessionId: `session-${index}`,
    sessionKey: run.sessionKey,
  }));
  const oracle: Oracle = {
    selected: sha256(
      canonical({
        store: { version: 1, jobs: rows },
        configJobs: definitions,
        configJobIndexes: rows.map((_row, index) => index),
        configJobRuntimeEntries: rows.map((job) => ({
          updatedAtMs: 1,
          scheduleIdentity: JSON.stringify({
            version: 2,
            enabled: true,
            schedule: { kind: "every", everyMs: 60_000 },
            hasTrigger: false,
          }),
          state: job.state,
        })),
        invalidConfigRows: [],
      }),
    ),
    inventory: sha256(
      canonical(
        definitions.map((definition, index) => ({
          storeKey: STORE_KEY,
          id: definition.id,
          sortOrder: index,
          definitionJson: canonical(definition),
          definition,
        })),
      ),
    ),
    history: sha256(canonical(history)),
    projection: sha256(canonical(projection)),
  };
  return { rows, writes, oracle };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "build-root": { type: "string" },
      "state-dir": { type: "string" },
      jobs: { type: "string" },
      phase: { type: "string" },
    },
  });
  assert(values["build-root"] && values["state-dir"], "build-root and state-dir are required");
  assert(
    values.phase === "prepare" || values.phase === "measure",
    "phase must be prepare or measure",
  );
  const jobs = Number(values.jobs);
  assert(jobs === 40 || jobs === 1000, "jobs must be 40 or 1000");
  assert.equal(process.env.NODE_OPTIONS ?? "", "", "run without NODE_OPTIONS instrumentation");
  assert.deepEqual(process.execArgv, [], "run with native Node type stripping and no preload");
  const buildRoot = await realpath(path.resolve(values["build-root"]));
  const dist = path.join(buildRoot, "dist");
  const statePath = path.resolve(values["state-dir"]);
  if (values.phase === "prepare") {
    await mkdir(statePath);
  }
  const state = await realpath(statePath);
  Object.assign(process.env, {
    HOME: state,
    OPENCLAW_HOME: state,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
  });
  const manifestPath = path.join(state, "cron-benchmark-fixture.json");
  let receipt: FixtureReceipt | undefined;
  if (values.phase === "measure") {
    receipt = JSON.parse(await readFile(manifestPath, "utf8")) as FixtureReceipt;
    assert.equal(receipt.version, 1);
    assert.equal(receipt.jobs, jobs);
    assert.equal(receipt.taskIds.length, jobs);
    assert.equal(new Set(receipt.taskIds).size, jobs);
    assert.deepEqual(
      receipt.runIds,
      Array.from({ length: jobs }, (_, index) => `run-synthetic-${String(index).padStart(4, "0")}`),
    );
    assert.deepEqual(Object.keys(receipt.oracle).toSorted(lexical), [
      "history",
      "inventory",
      "projection",
      "selected",
    ]);
    assert(Object.values(receipt.oracle).every((value) => /^[a-f0-9]{64}$/.test(value)));
  }
  const modules: Record<string, BuiltExport> = {};
  const exportNames = {
    selected: "loadCronJobsStoreWithConfigJobsReadOnlyByKey",
    inventory: "inspectCronJobsReadOnly",
    history: "readCronRunHistoryRecords",
    candidates: "readCronRunHistoryCandidates",
    projection: "cronRunRecordToRunLogEntry",
    close: "closeOpenClawStateDatabaseAsync",
    drain: "drainGlobalSingletonLifecycleState",
    closeNative: "closeDefaultRetainedNativeWorkerSource",
    captureNative: "captureRetainedNativeWorkerSource",
    lifecycle: "getTrackedWorkerLifecycleSnapshot",
    role: "installDatabaseProcessRole",
    save: "saveCronJobsStoreWithRevisionByKey",
    record: "recordCronRun",
  };
  const counts = new Map<string, number>();
  // Measured children consume prepared metadata: reading bundles here would
  // leave arm-dependent allocation garbage in the RSS observation window.
  if (!receipt) {
    const required = new Set(Object.values(exportNames));
    for (const file of readdirSync(dist)
      .filter((entry) => /^[A-Za-z0-9_-]+\.mjs$/.test(entry))
      .toSorted(lexical)) {
      const filePath = path.join(dist, file);
      const stat = lstatSync(filePath);
      assert(stat.isFile() && !stat.isSymbolicLink());
      const source = readFileSync(filePath, "utf8");
      for (const block of source.matchAll(/export\s*\{([^}]+)\};/g)) {
        for (const part of block[1]!.split(",").map((entry) => entry.trim())) {
          const match = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/.exec(
            part,
          );
          const name = match?.[1];
          // Chunk names can change and forwarding barrels repeat exports.
          // Select the unique chunk that declares and exports the actual function.
          if (
            name &&
            required.has(name) &&
            new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(source)
          ) {
            counts.set(name, (counts.get(name) ?? 0) + 1);
            modules[name] = { file, alias: match?.[2] ?? name, sha256: sha256(source) };
          }
        }
      }
    }
  }
  function resolve(name: string): BuiltExport {
    if (!receipt) {
      assert.equal(counts.get(name), 1, `unique compiled function export required: ${name}`);
    }
    const entry = receipt ? receipt.modules[name] : modules[name];
    assert(entry, `prepared compiled export required: ${name}`);
    assert.match(entry.file, /^[A-Za-z0-9_-]+\.mjs$/);
    assert.match(entry.alias, /^[A-Za-z_$][A-Za-z0-9_$]*$/);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    return (modules[name] = entry);
  }
  const selected = resolve(exportNames.selected);
  const inventory = resolve(exportNames.inventory);
  const history = resolve(exportNames.history);
  const candidates = resolve(exportNames.candidates);
  const projection = resolve(exportNames.projection);
  const close = resolve(exportNames.close);
  const drain = resolve(exportNames.drain);
  const closeNative = resolve(exportNames.closeNative);
  const captureNative = resolve(exportNames.captureNative);
  const lifecycle = resolve(exportNames.lifecycle);
  const role = resolve(exportNames.role);
  const save = resolve(exportNames.save);
  const record = resolve(exportNames.record);
  const workerEntry = "dist/cron/store/read-only.worker.js";
  const workerPath = path.join(buildRoot, workerEntry);
  if (receipt) {
    assert.deepEqual(
      Object.keys(receipt.modules).toSorted(lexical),
      Object.keys(modules).toSorted(lexical),
    );
    assert.equal(receipt.worker.entry, workerEntry);
    assert.match(receipt.worker.sha256, /^[a-f0-9]{64}$/);
  }
  const worker = receipt?.worker ?? {
    entry: workerEntry,
    sha256: sha256(readFileSync(workerPath)),
  };
  async function load<T>(entry: BuiltExport): Promise<T> {
    const module: Record<string, unknown> = await import(
      pathToFileURL(path.join(dist, entry.file)).href
    );
    assert.equal(typeof module[entry.alias], "function", `compiled export: ${entry.file}`);
    return module[entry.alias] as T;
  }
  const prepared = values.phase === "prepare" ? fixture(jobs) : undefined;
  const oracle = prepared?.oracle ?? receipt!.oracle;
  const report = {
    version: 1,
    phase: values.phase,
    jobs,
    runtime: {
      node: process.version,
      execArgv: process.execArgv,
      nodeOptionsSha256: sha256(process.env.NODE_OPTIONS ?? ""),
      compileCacheConfigured: Boolean(process.env.NODE_COMPILE_CACHE),
      compileCacheDisabled: process.env.NODE_DISABLE_COMPILE_CACHE ?? null,
    },
    modules,
    worker,
    oracle,
    cycles: [] as Array<{
      selected: Timing;
      inventory: Timing;
      history: Timing;
      projection: Timing;
      total: Timing;
    }>,
    graces: [] as Array<{ after: string; timing: Timing; memory: NodeJS.MemoryUsage }>,
    imports: undefined as Timing | undefined,
    cold: undefined as Timing | undefined,
    warm: undefined as Timing | undefined,
    total: undefined as Timing | undefined,
    cleanup: undefined as Timing | undefined,
    lifecycleBefore: undefined as
      | ReturnType<typeof Diagnostics.getTrackedWorkerLifecycleSnapshot>
      | undefined,
    lifecycleAfter: undefined as
      | ReturnType<typeof Diagnostics.getTrackedWorkerLifecycleSnapshot>
      | undefined,
    sampledPeakRssBytes: 0,
    rssSamples: 0,
    observedWorkerPaths: [] as string[],
    nativeWorkersAbsent: false,
    brokerJoined: false,
    complete: false,
    error: null as string | null,
    load: loadavg(),
  };
  let interval: ReturnType<typeof setInterval> | undefined;
  let closeDatabase: typeof State.closeOpenClawStateDatabaseAsync | undefined;
  let drainSingletons: typeof Singletons.drainGlobalSingletonLifecycleState | undefined;
  let closeSource: typeof Native.closeDefaultRetainedNativeWorkerSource | undefined;
  let source: ReturnType<typeof Native.captureRetainedNativeWorkerSource> | undefined;
  let snapshot: typeof Diagnostics.getTrackedWorkerLifecycleSnapshot | undefined;
  const observe = () => {
    report.sampledPeakRssBytes = Math.max(report.sampledPeakRssBytes, process.memoryUsage.rss());
    report.rssSamples++;
  };
  try {
    const total = clock();
    observe();
    if (values.phase === "measure") {
      interval = setInterval(observe, 20);
    }
    const imports = clock();
    closeDatabase = await load<typeof State.closeOpenClawStateDatabaseAsync>(close);
    drainSingletons = await load<typeof Singletons.drainGlobalSingletonLifecycleState>(drain);
    closeSource = await load<typeof Native.closeDefaultRetainedNativeWorkerSource>(closeNative);
    const capture = await load<typeof Native.captureRetainedNativeWorkerSource>(captureNative);
    snapshot = await load<typeof Diagnostics.getTrackedWorkerLifecycleSnapshot>(lifecycle);
    const installRole = await load<typeof Roles.installDatabaseProcessRole>(role);
    const readSelected =
      await load<typeof Reads.loadCronJobsStoreWithConfigJobsReadOnlyByKey>(selected);
    const readInventory = await load<typeof Reads.inspectCronJobsReadOnly>(inventory);
    const readHistory = await load<typeof Reads.readCronRunHistoryRecords>(history);
    const project = await load<typeof Projection.cronRunRecordToRunLogEntry>(projection);
    installRole("gateway");
    report.imports = elapsed(imports);
    source = capture({ runtimeGeneration: undefined });
    report.lifecycleBefore = snapshot();
    if (values.phase === "prepare") {
      const writeStore = await load<typeof Store.saveCronJobsStoreWithRevisionByKey>(save!);
      const writeRun = await load<typeof History.recordCronRun>(record!);
      const readCandidates = await load<typeof Reads.readCronRunHistoryCandidates>(candidates!);
      const { rows, writes } = prepared!;
      await writeStore(STORE_KEY, { version: 1, jobs: rows });
      for (const run of writes) {
        await writeRun(run);
      }
      const found = (await readCandidates(STORE_KEY)).records.toSorted((a, b) =>
        lexical(a.runId ?? "", b.runId ?? ""),
      );
      assert.deepEqual(
        found.map((entry) => entry.runId),
        writes.map((entry) => entry.runId),
      );
      receipt = {
        version: 1,
        jobs,
        taskIds: found.map((entry) => entry.id),
        runIds: writes.map((entry) => entry.runId),
        oracle,
        modules,
        worker,
      };
    }
    assert(receipt);
    const identities = new Map(receipt.taskIds.map((id, index) => [id, receipt!.runIds[index]!]));
    function verify(name: keyof Oracle, value: unknown) {
      assert.equal(sha256(canonical(value)), oracle[name], `full ${name} output differs`);
    }
    async function cycle() {
      const start = clock();
      let operation = clock();
      const loaded = await readSelected(STORE_KEY);
      const selectedTiming = elapsed(operation);
      verify("selected", loaded);
      const paths = source!.activeWorkerPaths();
      assert(
        paths.includes(workerPath),
        "actual native source must own the selected compiled cron worker",
      );
      assert(
        paths.every(
          (entry): entry is string =>
            typeof entry === "string" &&
            entry.startsWith(`${dist}${path.sep}`) &&
            !entry.endsWith(".ts"),
        ),
        "source worker or foreign build detected",
      );
      report.observedWorkerPaths = [
        ...new Set([
          ...report.observedWorkerPaths,
          ...paths.map((entry) => path.relative(buildRoot, entry)),
        ]),
      ].toSorted(lexical);
      operation = clock();
      const inspected = await readInventory(process.env);
      const inventoryTiming = elapsed(operation);
      verify(
        "inventory",
        inspected.map((entry) =>
          Object.assign({}, entry, {
            definitionJson: canonical(JSON.parse(entry.definitionJson)),
          }),
        ),
      );
      operation = clock();
      const records: CronRunRecord[] = [];
      for (let index = 0; index < receipt!.taskIds.length; index += 200) {
        records.push(
          ...(await readHistory(STORE_KEY, receipt!.taskIds.slice(index, index + 200), "full")),
        );
      }
      const historyTiming = elapsed(operation);
      records.sort((a, b) => lexical(a.runId ?? "", b.runId ?? ""));
      verify(
        "history",
        records.map((entry) => {
          assert.equal(identities.get(entry.id), entry.runId, "history task/run identity");
          return Object.assign({}, entry, { id: entry.runId });
        }),
      );
      operation = clock();
      const projected = records.map(project);
      const projectionTiming = elapsed(operation);
      verify("projection", projected);
      report.cycles.push({
        selected: selectedTiming,
        inventory: inventoryTiming,
        history: historyTiming,
        projection: projectionTiming,
        total: elapsed(start),
      });
      observe();
    }
    async function grace(after: string) {
      const start = clock();
      await delay(IDLE_MS);
      const timing = elapsed(start);
      assert(timing.wallMs >= IDLE_MS - 10);
      report.graces.push({ after, timing, memory: process.memoryUsage() });
      observe();
    }
    if (values.phase === "prepare") {
      await cycle();
    } else {
      let start = clock();
      await cycle();
      report.cold = elapsed(start);
      await grace("cold");
      start = clock();
      for (let index = 0; index < WARM_CYCLES; index++) {
        await cycle();
      }
      report.warm = elapsed(start);
      await grace("warm");
      assert.equal(report.cycles.length, 1 + WARM_CYCLES);
      assert.equal(report.graces.length, 2);
    }
    report.total = elapsed(total);
  } catch (error) {
    report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    if (interval) {
      clearInterval(interval);
    }
    const start = clock();
    try {
      await closeDatabase?.();
      await drainSingletons?.("close");
      await closeSource?.();
      assert(
        source && !source.hasActiveWorkers && source.activeWorkerPaths().length === 0,
        "native workers must join before fixture cleanup",
      );
      report.nativeWorkersAbsent = true;
      assert.equal(
        await source.retireIdleBroker(),
        true,
        "independent native resource claims must close and the broker must join",
      );
      report.brokerJoined = true;
      report.lifecycleAfter = snapshot?.();
      assert.equal(report.lifecycleAfter?.workerCount, 0, "tracked workers remain after close");
    } catch (error) {
      report.error ??= error instanceof Error ? (error.stack ?? error.message) : String(error);
    }
    report.cleanup = elapsed(start);
  }
  report.complete = report.error === null && report.nativeWorkersAbsent && report.brokerJoined;
  if (report.complete && values.phase === "prepare") {
    await writeFile(manifestPath, JSON.stringify(receipt), { flag: "wx" });
  }
  console.log(JSON.stringify(report));
  if (!report.complete) {
    throw new Error(report.error ?? "incomplete cron reader proof");
  }
}

await main().catch((error: unknown) => {
  console.error(error);
  console.error("[cron-reader-reuse-measure] FAILED (exit 1)");
  process.exitCode = 1;
});
