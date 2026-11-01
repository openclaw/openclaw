/**
 * Fresh archive-session workers against an existing synthetic 10k-session fixture.
 * Prepare with archive-worker-churn-measure.ts, then run from the repository root:
 * node --import ./scripts/tsx.mjs scripts/perf/archive-worker-startup-measure.mjs \
 *   --database <fixture>/state/agents/main/agent/openclaw-agent.sqlite \
 *   --state-dir <fixture>/state --baseline-dir <source-overlay> \
 *   --output .local/startup.json --samples 10 --diagnose
 * The overlay contains only changed source files at repository-relative paths.
 * AB/BA order alternates; workers run serially and close through the real protocol.
 * --entry accepts an already-built archive worker; omit --baseline-dir for a
 * single built revision. Both arms otherwise use the same source loader.
 * Empty cold selections preserve all session data. Thread CPU and V8 allocation
 * start after the probe/loader prelude; RSS is process-wide. GC uses GCProfiler,
 * without trace-gc or forced collections. Module counts include
 * file URLs seen by Node load hooks, not builtins or compiler helper processes.
 * --diagnose adds untimed-for-comparison phase attribution: archive imports,
 * preparation imports, fresh admission, then the same selection on that handle.
 * Admission is standalone, without Gateway-published admission facts. This is
 * worker-boundary proof, not a whole-Gateway load or latency claim.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler, getHeapStatistics } from "node:v8";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const sourceEntry = "src/config/sessions/session-accessor.sqlite-archive.worker.ts";

if (!isMainThread) {
  const { entry, overlay, diagnose, input } = workerData.benchmark;
  const modules = new Set();
  registerHooks({
    load(url, context, next) {
      if (url.startsWith("file:")) {
        modules.add(url);
        const relative = path.relative(repository, fileURLToPath(url));
        const replacement = overlay && path.join(overlay, relative);
        if (replacement && !relative.startsWith("..") && fs.existsSync(replacement)) {
          const loaded = next(pathToFileURL(replacement).href, context);
          return { ...loaded, shortCircuit: true };
        }
      }
      return next(url, context);
    },
  });
  const profiler = new GCProfiler();
  const baseline = () => ({
    wall: performance.now(),
    cpu: process.threadCpuUsage(),
    allocated: getHeapStatistics().total_allocated_bytes,
    modules: modules.size,
  });
  const metrics = (start) => {
    const cpu = process.threadCpuUsage(start.cpu);
    const elapsedMs = performance.now() - start.wall;
    const allocatedBytes = getHeapStatistics().total_allocated_bytes - start.allocated;
    const collections = profiler.stop().statistics;
    const byKind = {};
    for (const collection of collections) {
      const kind = (byKind[collection.gcType] ??= { count: 0, ms: 0, maxMs: 0 });
      kind.count++;
      kind.ms += collection.cost / 1000;
      kind.maxMs = Math.max(kind.maxMs, collection.cost / 1000);
    }
    return {
      elapsedMs,
      threadCpuMs: (cpu.user + cpu.system) / 1000,
      allocatedBytes,
      fileModulesLoaded: modules.size - start.modules,
      gcMs: collections.reduce((sum, collection) => sum + collection.cost / 1000, 0),
      gcCount: collections.length,
      maxGcMs: Math.max(0, ...collections.map((collection) => collection.cost / 1000)),
      gcByKind: byKind,
      heapUsedBytes: process.memoryUsage().heapUsed,
      processRssBytes: process.memoryUsage().rss,
    };
  };
  profiler.start();
  const started = baseline();
  assert(Number.isFinite(started.allocated), "V8 total_allocated_bytes requires Node 26.12+");
  if (diagnose) {
    const phases = {};
    let checkpoint = started;
    const phase = (name) => {
      phases[name] = metrics(checkpoint);
      profiler.start();
      checkpoint = baseline();
    };
    await import(entry);
    phase("archiveImports");
    // Follow the production dispatch's import instead of maintaining a second arm map.
    const archiveSource = fs.readFileSync(
      overlay ? path.join(overlay, sourceEntry) : path.join(repository, sourceEntry),
      "utf8",
    );
    const preparation = archiveSource.match(
      /const \{ prepareSessionColdBatchInWorker \} =\s*await import\("([^"]+)"\)/u,
    )?.[1];
    assert(preparation, "Could not resolve the cold-preparation dispatch import");
    const { prepareSessionColdBatchInWorker } = await import(new URL(preparation, entry).href);
    const { OpenClawAgentDatabaseReadOnlyScope } =
      await import("../../src/state/openclaw-agent-db-readonly-scope.ts");
    const { withOpenClawAgentDatabaseReadOnly } =
      await import("../../src/state/openclaw-agent-db-readonly.ts");
    phase("preparationImports");
    const scope = new OpenClawAgentDatabaseReadOnlyScope();
    try {
      await scope.run(input.databaseOptions, async () => {
        const opened = withOpenClawAgentDatabaseReadOnly(() => true, input.databaseOptions);
        assert(opened.found, "Synthetic database must exist");
        phase("databaseAdmission");
        const result = await prepareSessionColdBatchInWorker(input);
        phase("selection");
        parentPort.postMessage(
          {
            phases,
            result,
            modules: [...modules].toSorted((left, right) => left.localeCompare(right)),
          },
          [],
        );
      });
    } finally {
      scope.close();
      profiler.stop();
      parentPort.close();
    }
  } else {
    const post = parentPort.postMessage.bind(parentPort);
    parentPort.postMessage = (message, ...args) =>
      post(
        message.type === "cold-prepared" ? { ...message, measurement: metrics(started) } : message,
        ...args,
      );
    await import(entry);
  }
} else {
  const { values } = parseArgs({
    options: {
      database: { type: "string" },
      "state-dir": { type: "string" },
      "baseline-dir": { type: "string" },
      "owner-dir": { type: "string" },
      entry: { type: "string" },
      output: { type: "string" },
      samples: { type: "string", default: "10" },
      diagnose: { type: "boolean", default: false },
    },
  });
  assert(
    values.database && values["state-dir"] && values.output,
    "database, state-dir, output required",
  );
  assert(
    !(values["baseline-dir"] && values["owner-dir"]),
    "Choose comparison or one owner overlay",
  );
  assert(!(values.entry && values.diagnose), "Phase diagnosis uses source entries");
  assert(
    !(values.entry && (values["baseline-dir"] || values["owner-dir"])),
    "Measure built revisions separately without a source overlay",
  );
  const samples = Number(values.samples);
  assert(Number.isSafeInteger(samples) && samples > 0);
  const state = fs.realpathSync(values["state-dir"]);
  const database = fs.realpathSync(values.database);
  assert(
    database.startsWith(`${state}${path.sep}`),
    "Database must be inside synthetic state root",
  );
  const root = path.dirname(path.resolve(values.output));
  fs.mkdirSync(root, { recursive: true });
  const home = path.join(root, "startup-home");
  const temp = path.join(root, "startup-tmp");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  const env = {
    HOME: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(root, "absent-startup-config.json"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    TMPDIR: temp,
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
  };
  const input = {
    databaseOptions: { agentId: "main", path: database, env },
    admissionIdentities: [],
    liveSessionKeys: [],
    cooledSessionIds: [],
    beforeMs: 0,
    maxTranscripts: 128,
    maxBytes: 64 * 1024 * 1024,
  };
  const arms = values["baseline-dir"]
    ? { base: path.resolve(values["baseline-dir"]), candidate: undefined }
    : { candidate: values["owner-dir"] ? path.resolve(values["owner-dir"]) : undefined };
  const report = { node: process.version, samples, input, runs: [], diagnostics: {} };
  const entry = pathToFileURL(path.resolve(values.entry ?? sourceEntry)).href;
  const empty = (result) => {
    for (const key of ["prepared", "externalizations", "protectionKeys", "oversizedTranscripts"]) {
      assert.deepEqual(result[key], [], `Expected empty ${key}`);
    }
    assert.equal(result.envelopeBytes, 0);
  };
  const run = async (overlay, diagnose = false) => {
    const started = performance.now();
    const load = os.loadavg();
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        type: diagnose ? "archive-startup-diagnosis" : "sqlite-transcript-archive-v2",
        operation: "archive-session",
        env,
        benchmark: { overlay, entry, diagnose, input },
      },
      env,
      execArgv: values.entry ? [] : ["--import", path.join(repository, "scripts/tsx.mjs")],
    });
    const exited = once(worker, "exit");
    void exited.catch(() => {});
    try {
      const reply = once(worker, "message");
      if (!diagnose) {
        worker.postMessage({ operation: "cold-prepare", input }, []);
      }
      const [message] = await reply;
      const responseMs = performance.now() - started;
      empty(diagnose ? message.result : message.results[0]);
      if (!diagnose) {
        worker.postMessage({ type: "close" }, []);
      }
      const [code] = await exited;
      assert.equal(code, 0, "Archive worker must exit cleanly");
      return diagnose ? message : { ...message.measurement, responseMs, load };
    } catch (error) {
      await worker.terminate();
      throw error;
    }
  };
  for (let iteration = 0; iteration < samples; iteration++) {
    const names = Object.keys(arms);
    if (iteration % 2) {
      names.reverse();
    }
    for (const arm of names) {
      const result = await run(arms[arm]);
      report.runs.push({ iteration, arm, ...result });
      fs.writeFileSync(values.output, JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ iteration, arm, ...result }));
    }
  }
  if (values.diagnose) {
    for (const [arm, overlay] of Object.entries(arms)) {
      report.diagnostics[arm] = await run(overlay, true);
    }
  }
  fs.writeFileSync(values.output, JSON.stringify(report, null, 2));
}
