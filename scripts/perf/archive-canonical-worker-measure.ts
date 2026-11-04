/**
 * Canonical validation through the real archive pool, with 10k synthetic pending rows.
 * node --import ./scripts/tsx.mjs scripts/perf/archive-canonical-worker-measure.ts \
 *   --output .local/canonical-candidate --sessions 10000 --iterations 5
 * --operation reclaim deletes one freshly seeded transcript-bearing target among
 * the 10k background rows, samples its retained worker, then closes its database.
 * --entry-mib adds synthetic entry payload for reclamation retention; --snapshot
 * captures the idle worker after forced GC, outside task timing.
 * Add --owner-dir <source-overlay> for baseline bytes at repository-relative paths.
 * Or use --entry <built-repo>/dist/config/sessions/session-accessor.sqlite-archive.worker.js
 * to measure its built worker with package aliases disabled, as in Gateway stress.
 * Run fresh baseline/candidate processes serially in AB/BA order. Every iteration
 * creates a fresh pool, certifies the same rows, samples its idle heap, then joins it.
 * Startup counters begin after the loader/probe prelude, before worker entry imports.
 * Task latency/CPU/allocation stop before forced GC; allocation uses Node 26.12+ counters.
 * Worker CPU/allocation includes entry imports and the real certification task.
 * Owner latency includes the identical preload counter-start handshake. RSS is
 * process-wide. Instrumented owner/isolate durations include post-task probes and
 * forced GC, so they are not production lifetime comparisons. Heap code
 * statistics identify code bytes, not all module-retained objects. This is an owner
 * probe, not whole-Gateway stress. Output directories must be new and task-owned.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import workerThreads, { isMainThread, threadId } from "node:worker_threads";

const retainedPreload = new URL("./worker-retained-heap-preload.ts", import.meta.url).href;

async function waitJson(file: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 120_000;
  while (!fs.existsSync(file)) {
    assert(Date.now() < deadline, `Timed out waiting for ${path.basename(file)}`);
    await delay(10);
  }
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function probe(
  prefix: string,
  id: string,
  operation: "start" | "stop" | "collect" | "snapshot",
): Promise<Record<string, unknown>> {
  await waitJson(`${prefix}.ready.json`);
  const command = `${prefix}.command.json`;
  fs.writeFileSync(`${command}.tmp`, JSON.stringify({ id, operation }));
  fs.renameSync(`${command}.tmp`, command);
  const result = await waitJson(`${prefix}.${id}.json`);
  assert(result.ok === true, JSON.stringify(result));
  return result;
}

if (!isMainThread) {
  const output = process.env.OPENCLAW_BENCH_RETAINED_WORKER_DIR;
  assert(output);
  // This script is a preload only for the measured archive worker, never its entrypoint.
  await probe(path.join(output, `worker-${process.pid}-${threadId}`), "startup-start", "start");
} else {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      "owner-dir": { type: "string" },
      entry: { type: "string" },
      sessions: { type: "string", default: "10000" },
      iterations: { type: "string", default: "5" },
      operation: { type: "string", default: "canonical" },
      "entry-mib": { type: "string", default: "0" },
      snapshot: { type: "boolean", default: false },
    },
  });
  assert(values.output, "--output is required");
  const root = path.resolve(values.output);
  assert(!(values.entry && values["owner-dir"]), "Built workers cannot use source overlays");
  const entry = values.entry ? fs.realpathSync(values.entry) : undefined;
  const operation = values.operation;
  assert(operation === "canonical" || operation === "reclaim");
  const workerOperation = operation === "canonical" ? "canonical-validation-pool" : "reclaim";
  const sessions = Number(values.sessions);
  const iterations = Number(values.iterations);
  const entryMiB = Number(values["entry-mib"]);
  assert(Number.isSafeInteger(sessions) && sessions > 0);
  assert(Number.isSafeInteger(iterations) && iterations > 0);
  assert(Number.isSafeInteger(entryMiB) && entryMiB >= 0);
  assert(entryMiB === 0 || operation === "reclaim", "--entry-mib requires --operation reclaim");
  assert(!fs.existsSync(root), "Refusing to overwrite an existing output directory");
  fs.mkdirSync(root, { recursive: true });
  const output = path.join(root, "workers");
  for (const directory of ["home", "state", "tmp", "workers", "empty-overlay"]) {
    fs.mkdirSync(path.join(root, directory));
  }
  Object.assign(process.env, {
    HOME: path.join(root, "home"),
    OPENCLAW_HOME: path.join(root, "home"),
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    TMPDIR: path.join(root, "tmp"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_BENCH_RETAINED_WORKER_DIR: output,
    OPENCLAW_BENCH_BASELINE_DIR: values["owner-dir"]
      ? path.resolve(values["owner-dir"])
      : path.join(root, "empty-overlay"),
  });
  fs.writeFileSync(
    process.env.OPENCLAW_CONFIG_PATH!,
    JSON.stringify({ plugins: { enabled: false } }),
  );
  await import("./worker-retained-heap-preload.js");

  type Observation = {
    worker: workerThreads.Worker;
    prefix: string;
    startedAt: number;
    exitedAt?: number;
    task?: Record<string, unknown>;
    idleHeap?: Record<string, unknown>;
  };
  const observations: Observation[] = [];
  const NativeWorker = workerThreads.Worker;
  workerThreads.Worker = class extends NativeWorker {
    constructor(filename: string | URL, options: workerThreads.WorkerOptions = {}) {
      const measured = options.workerData?.operation === workerOperation;
      super(
        measured && entry ? entry : filename,
        measured
          ? {
              ...options,
              execArgv: [
                ...(entry
                  ? ["--import", new URL("./team-shape-stress-loader.mjs", import.meta.url).href]
                  : (options.execArgv ?? process.execArgv)),
                "--import",
                retainedPreload,
                "--import",
                import.meta.url,
              ],
            }
          : options,
      );
      if (!measured) {
        return;
      }
      const observation: Observation = {
        worker: this,
        prefix: path.join(output, `worker-${process.pid}-${this.threadId}`),
        startedAt: performance.now(),
      };
      observations.push(observation);
      this.once("exit", () => {
        observation.exitedAt = performance.now();
      });
    }
  };
  syncBuiltinESMExports();

  const agentDb = await import("../../src/state/openclaw-agent-db.js");
  const stateDb = await import("../../src/state/openclaw-state-db.js");
  const { markCanonicalSessionValidationPending } =
    await import("../../src/config/sessions/session-canonical-key.js");
  const { hasPendingCanonicalSessionValidation } =
    await import("../../src/config/sessions/session-canonical-validation.js");
  const { certifySessionCanonicalValidationPending } =
    await import("../../src/config/sessions/session-canonical-validation-readiness.js");
  const { withSqliteCanonicalValidationWorker } =
    await import("../../src/config/sessions/session-accessor.sqlite-reclamation-worker.js");
  const { withSqliteCanonicalValidationWorkerPool } =
    await import("../../src/config/sessions/session-accessor.sqlite-canonical-worker-pool.js");
  const { installDatabaseProcessRole } =
    await import("../../src/infra/database-engine/admission-scope.js");
  installDatabaseProcessRole("gateway");
  const options = { agentId: "main", env: process.env };
  let database = agentDb.openOpenClawAgentDatabase(options);
  agentDb.runOpenClawAgentWriteTransaction(({ db }) => {
    const insert = db.prepare(
      "INSERT INTO session_nodes (session_key,current_session_id,entry_json,entry_valid,updated_at) VALUES (?,?,?,1,1)",
    );
    for (let index = 0; index < sessions; index++) {
      const sessionId = `synthetic-${index}`;
      insert.run(
        `agent:main:subagent:${sessionId}`,
        sessionId,
        JSON.stringify({ sessionId, updatedAt: 1, status: "done" }),
      );
    }
  }, options);
  const deletion =
    operation === "reclaim"
      ? await import("../../src/config/sessions/session-accessor.sqlite-lifecycle.js")
      : undefined;
  const creation =
    operation === "reclaim"
      ? await import("../../src/config/sessions/session-accessor.sqlite-initial-entry.js")
      : undefined;
  const measurements = [];
  try {
    for (let iteration = 0; iteration < iterations; iteration++) {
      database = agentDb.openOpenClawAgentDatabase(options);
      const sessionId = `synthetic-delete-${iteration}`;
      const sessionKey = `agent:main:subagent:${sessionId}`;
      if (operation === "canonical") {
        markCanonicalSessionValidationPending(database);
      } else {
        assert(creation);
        creation.ensureSessionEntrySync(
          { ...options, sessionKey },
          {
            sessionId,
            updatedAt: 1,
            ...(entryMiB
              ? {
                  skillsSnapshot: {
                    prompt: "synthetic-retained-entry".padEnd(entryMiB * 1024 * 1024, "x"),
                    skills: [],
                  },
                }
              : {}),
          },
        );
        // Empty transcripts use the ordinary writer, so seed real reclamation work.
        agentDb.runOpenClawAgentWriteTransaction(({ db }) => {
          db.prepare(
            "INSERT INTO transcript_rewrite_watermarks (session_id,generation,updated_at) VALUES (?,?,1)",
          ).run(sessionId, `generation-${iteration}`);
          const json = JSON.stringify({ type: "session", id: sessionId, version: 3 });
          db.prepare(
            "INSERT INTO transcript_events (session_id,seq,event_json,event_utf8_bytes,created_at) VALUES (?,0,?,?,1)",
          ).run(sessionId, json, Buffer.byteLength(json));
        }, options);
      }
      const previous = observations.length;
      const started = performance.now();
      let taskElapsedMs = 0;
      const measure = async (run: () => Promise<void>) => {
        await run();
        taskElapsedMs = performance.now() - started;
        const observed = observations.slice(previous);
        assert.equal(observed.length, 1, "One store must use one measured archive worker");
        const observation = observed[0]!;
        observation.task = await probe(observation.prefix, "task-stop", "stop");
        observation.idleHeap = await probe(
          observation.prefix,
          "idle-heap",
          values.snapshot ? "snapshot" : "collect",
        );
        assert.equal(
          database.db.prepare("SELECT COUNT(*) AS count FROM session_nodes").get()?.count,
          sessions,
        );
      };
      if (operation === "canonical") {
        await withSqliteCanonicalValidationWorkerPool(process.env, () =>
          measure(async () => {
            await withSqliteCanonicalValidationWorker((withWorker) =>
              certifySessionCanonicalValidationPending(options, withWorker),
            );
            assert.equal(hasPendingCanonicalSessionValidation(database), false);
          }),
        );
      } else {
        await measure(async () => {
          assert(deletion);
          const result = await deletion.deleteSessionEntryLifecycle({
            ...options,
            archiveTranscript: false,
            deleteTranscriptWithoutArchive: true,
            storePath: database.path,
            target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          });
          assert.equal(result.deleted, true);
          assert.equal(result.deletedSessionId, sessionId);
          assert.equal(
            database.db
              .prepare("SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?")
              .get(sessionId)?.count,
            0,
          );
        });
        // Close the real retained owner and its native lease, never terminate for success.
        await agentDb.closeOpenClawAgentDatabasesAsync();
      }
      const observation = observations[previous]!;
      assert(observation.exitedAt !== undefined, "Owner close must join the measured worker");
      const { initialMemory, finalMemory, cpu } = observation.task!;
      assert(
        initialMemory && typeof initialMemory === "object" && "allocatedBytes" in initialMemory,
      );
      assert(finalMemory && typeof finalMemory === "object" && "allocatedBytes" in finalMemory);
      assert(cpu && typeof cpu === "object" && "user" in cpu && "system" in cpu);
      assert(
        typeof initialMemory.allocatedBytes === "number" &&
          Number.isFinite(initialMemory.allocatedBytes),
      );
      assert(
        typeof finalMemory.allocatedBytes === "number" &&
          Number.isFinite(finalMemory.allocatedBytes),
      );
      assert(typeof cpu.user === "number" && typeof cpu.system === "number");
      measurements.push({
        iteration,
        instrumentedOwnerElapsedMs: performance.now() - started,
        taskElapsedMs,
        workerAllocatedBytes: finalMemory.allocatedBytes - initialMemory.allocatedBytes,
        workerCpuMs: (cpu.user + cpu.system) / 1000,
        instrumentedIsolateSeconds: (observation.exitedAt - observation.startedAt) / 1000,
        liveAfterClose: observations.filter((item) => item.exitedAt === undefined).length,
        load: loadavg(),
        task: observation.task,
        idleHeap: observation.idleHeap,
      });
    }
    const sorted = measurements.map((item) => item.taskElapsedMs).toSorted((a, b) => a - b);
    const result = {
      format: "archive-canonical-worker-v1",
      node: process.version,
      sessions,
      iterations,
      entryMiB,
      snapshots: values.snapshot,
      operation,
      workerOperation,
      owner: values["owner-dir"] ?? null,
      entry: entry ?? null,
      workersStarted: observations.length,
      instrumentedIsolateSeconds: measurements.reduce(
        (sum, item) => sum + item.instrumentedIsolateSeconds,
        0,
      ),
      taskLatency: {
        samples: sorted.length,
        p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      },
      measurements,
      correctness:
        "Background rows remain; canonical certification or target deletion succeeds; every measured worker joins.",
    };
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    await Promise.all(
      observations
        .filter((item) => item.exitedAt === undefined)
        .map((item) => item.worker.terminate()),
    );
    await agentDb.closeOpenClawAgentDatabasesAsync();
    await stateDb.closeOpenClawStateDatabaseAsync();
    await (await import("esbuild")).stop();
  }
}
