/**
 * Synthetic large-row workspace identity lookup through the real state-read pool.
 * node --import ./scripts/tsx.mjs scripts/perf/local-workspace-lookup-measure.ts prepare .local/lookup
 * node --import ./scripts/tsx.mjs scripts/perf/local-workspace-lookup-measure.ts run .local/lookup candidate [timing|allocation|cpu] [iterations=1000]
 * Set OPENCLAW_BENCH_BASELINE_DIR to a sparse original-source overlay for baseline.
 * Alternate arms; sampling is a separate pass. The fixture has 10,000 workspace
 * rows, one pending 2 MiB recovery pack and a 2 MiB checkpoint. Four lookup and
 * four config reads contend per cohort. This measures owner/pool work, not a
 * whole Gateway or filesystem reconciliation. Exact identity facts and unchanged
 * recovery bytes are checked; no schema, lease, or production state is modified.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { serialize } from "node:v8";

const [mode, scratchArgument, label, instrumentation = "timing", iterationsArgument = "1000"] =
  process.argv.slice(2);
assert.ok(mode === "prepare" || mode === "run");
assert.ok(scratchArgument);
const scratch = path.resolve(scratchArgument);
const iterations = Number(iterationsArgument);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0 && iterations % 4 === 0);
assert.ok(["timing", "allocation", "cpu"].includes(instrumentation));
const env = {
  ...process.env,
  HOME: path.join(scratch, "home"),
  OPENCLAW_HOME: path.join(scratch, "home"),
  OPENCLAW_STATE_DIR: path.join(scratch, "state"),
  OPENCLAW_CONFIG_PATH: path.join(scratch, "config.json"),
  TMPDIR: path.join(scratch, "tmp"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
};
Object.assign(process.env, env);
await fs.mkdir(scratch, { recursive: true });
await fs.mkdir(env.HOME, { recursive: true });
await fs.mkdir(env.TMPDIR, { recursive: true });
const output = path.join(scratch, "results", label ?? "prepare");
if (mode === "run") {
  assert.ok(label && /^[a-zA-Z0-9_-]+$/.test(label));
  await fs.mkdir(output, { recursive: false });
  process.env.OPENCLAW_BENCH_RETAINED_WORKER_DIR = output;
  if (instrumentation === "allocation") {
    process.env.OPENCLAW_BENCH_SAMPLE_ALLOCATION = "1";
  }
  if (instrumentation === "cpu") {
    process.env.OPENCLAW_BENCH_SAMPLE_CPU = "1";
  }
  await import("./worker-retained-heap-preload.js");
}
const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
  await import("../../src/state/openclaw-state-db.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const database = openOpenClawStateDatabase({ env });
const worktreeId = "synthetic-workspace-9999";
const projectionPath = path.join(scratch, "workspace", worktreeId);
const expected = {
  worktree_id: worktreeId,
  agent_id: "main",
  session_key: `agent:main:${worktreeId}`,
  session_id: worktreeId,
  lifecycle_revision: "synthetic-generation",
};
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const distribution = (values: number[]) => {
  values.sort((a, b) => a - b);
  return {
    samples: values.length,
    p50Ms: values[Math.ceil(values.length * 0.5) - 1],
    p99Ms: values[Math.ceil(values.length * 0.99) - 1],
    maxMs: values.at(-1),
  };
};
try {
  if (mode === "prepare") {
    await fs.mkdir(path.join(scratch, "results"), { recursive: true });
    const { mutateLocalWorkspaceProjection } =
      await import("../../src/gateway/worker-environments/local-workspace-store.kernel.js");
    const { runSqliteImmediateTransactionSync } =
      await import("../../src/infra/sqlite-transaction.js");
    runSqliteImmediateTransactionSync(database.db, () => {
      for (let index = 0; index < 10_000; index++) {
        const id = `synthetic-workspace-${index}`;
        const heavy = id === worktreeId;
        mutateLocalWorkspaceProjection(database.db, id, {
          kind: "create",
          row: {
            worktree_id: id,
            agent_id: "main",
            session_key: `agent:main:${id}`,
            session_id: id,
            lifecycle_revision: "synthetic-generation",
            projection_path: path.join(scratch, "workspace", id),
            base_commit: "a".repeat(40),
            source_paths_json: "[]",
            baseline_json: null,
            baseline_ref: null,
            tree_root_digest: null,
            source_paths_digest: null,
            canonical_fingerprints: null,
            projection_fingerprints: null,
            checkpoint_json: heavy
              ? JSON.stringify({ synthetic: "x".repeat(2 * 1024 * 1024) })
              : null,
            pending_ref: heavy ? "refs/openclaw/results/pending" : null,
            pending_target: heavy ? "canonical" : null,
            journal_json: heavy ? "{}" : null,
            journal_pack: heavy ? Buffer.alloc(2 * 1024 * 1024, 7) : null,
            paused_runtimes_json: null,
            created_at_ms: 1,
          },
        });
      }
    });
    console.log(JSON.stringify({ prepared: 10_000, recoveryBytes: 4 * 1024 * 1024 }));
  } else {
    const { executeExistingOpenClawStateRead } =
      await import("../../src/state/openclaw-state-db-readonly.js");
    const { onWorkerRequestMetrics } =
      await import("../../src/infra/worker-request-diagnostics.js");
    const { setDiagnosticsEnabledForProcess } =
      await import("../../src/infra/diagnostic-events.js");
    setDiagnosticsEnabledForProcess(true);
    const lookup = () =>
      executeExistingOpenClawStateRead(
        { env },
        { type: "localWorkspace.byProjectionPath", input: { projectionPath } },
        { current: true, live: true },
      );
    const config = () =>
      executeExistingOpenClawStateRead(
        { env },
        { type: "config.health.read", input: undefined },
        { current: true, live: true },
      );
    const readRecovery = () =>
      executeExistingOpenClawStateRead(
        { env },
        { type: "localWorkspace.get", input: { id: worktreeId } },
        { current: true, live: true },
      );
    const recoveryDigest = async () => {
      const reply = await readRecovery();
      assert.ok(reply?.row);
      return digest(serialize(reply.row));
    };
    const before = await recoveryDigest();
    await Promise.all([lookup(), lookup(), config(), config()]);
    const identities = await Promise.all(
      (await fs.readdir(output))
        .filter((file) => file.endsWith(".ready.json"))
        .map(async (file) => JSON.parse(await fs.readFile(path.join(output, file), "utf8"))),
    );
    const workers = identities.filter((worker) =>
      worker.script.startsWith("openclaw-state-read.worker"),
    );
    assert.equal(workers.length, 2, "warm both shared readers before measurement");
    let sequence = 0;
    const command = async (worker: (typeof workers)[number], operation: string) => {
      const id = `${operation}-${++sequence}`;
      const reply = worker.commandPath.replace(".command.json", `.${id}.json`);
      await fs.writeFile(`${worker.commandPath}.tmp`, JSON.stringify({ id, operation }));
      await fs.rename(`${worker.commandPath}.tmp`, worker.commandPath);
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const raw = await fs.readFile(reply, "utf8").catch(() => undefined);
        if (raw) {
          const value = JSON.parse(raw);
          assert.equal(value.ok, true);
          return value;
        }
        await setTimeout(10);
      }
      throw new Error(`Worker command ${id} timed out`);
    };
    await Promise.all(workers.map((worker) => command(worker, "collect")));
    await Promise.all(workers.map((worker) => command(worker, "start")));
    const queued: Record<string, number[]> = {};
    const durations: Record<string, number[]> = {};
    const unsubscribe = onWorkerRequestMetrics(
      (kind, requestClass, phase, _depth, wait, duration) => {
        if (kind !== "stateRead") {
          return;
        }
        if (phase === "started" && wait !== undefined) {
          (queued[requestClass] ??= []).push(wait);
        }
        if (phase === "completed" && duration !== undefined) {
          (durations[requestClass] ??= []).push(duration);
        }
      },
    );
    const lookupMs: number[] = [];
    const configMs: number[] = [];
    let replyBytes = 0;
    const started = performance.now();
    const hostLoad = os.loadavg();
    for (let index = 0; index < iterations; index += 4) {
      await Promise.all(
        Array.from({ length: 8 }, async (_, slot) => {
          const start = performance.now();
          if (slot < 4) {
            const reply = await lookup();
            lookupMs.push(performance.now() - start);
            assert.ok(reply?.projection);
            const { worktree_id, agent_id, session_key, session_id, lifecycle_revision } =
              reply.projection;
            assert.deepEqual(
              { worktree_id, agent_id, session_key, session_id, lifecycle_revision },
              expected,
            );
            if (!replyBytes) {
              replyBytes = serialize(reply).byteLength;
            }
          } else {
            await config();
            configMs.push(performance.now() - start);
          }
        }),
      );
    }
    const elapsedMs = performance.now() - started;
    unsubscribe();
    const measured = await Promise.all(workers.map((worker) => command(worker, "stop")));
    assert.equal(await recoveryDigest(), before, "lookup must preserve pending recovery bytes");
    const result = {
      label,
      instrumentation,
      iterations,
      workspaces: 10_000,
      recoveryBytes: 4 * 1024 * 1024,
      elapsedMs,
      hostLoad,
      finalHostLoad: os.loadavg(),
      replyBytes,
      lookup: distribution(lookupMs),
      config: distribution(configMs),
      queueWait: Object.fromEntries(
        Object.entries(queued).map(([key, values]) => [key, distribution(values)]),
      ),
      workerDuration: Object.fromEntries(
        Object.entries(durations).map(([key, values]) => [key, distribution(values)]),
      ),
      workers: measured,
    };
    await fs.writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
} finally {
  await closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
}
