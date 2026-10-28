/**
 * Worker input owner microbenchmark, using the real pool and a synthetic echo transport.
 * node --expose-gc --allow-natives-syntax scripts/perf/worker-task-input-measure.mjs \
 *   BASE_OWNER_FILE CANDIDATE_OWNER_FILE
 * Run from a checkout with esbuild installed. Five AB/BA passes, 5,000 tasks per
 * arm/pass; untraced CPU and separately sampled allocation (including collected objects).
 * The separate V8 work-count regression asserts zero dictionary conversions on
 * candidate tasks. Baseline counts are reported without asserting zero.
 * This does not measure IPC, provider work, or whole-Gateway latency.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileFunction } from "node:vm";
import { build } from "esbuild";

const [baselineFile, candidateFile] = process.argv.slice(2);
assert(baselineFile && candidateFile, "BASE_OWNER_FILE CANDIDATE_OWNER_FILE required");
assert(globalThis.gc, "--expose-gc required");
const fast = compileFunction("return %HasFastProperties(value)", ["value"]);
const temporary = mkdtempSync(path.join(tmpdir(), "worker-task-input-"));
process.once("exit", () => rmSync(temporary, { recursive: true, force: true }));
const ownerPath = path.resolve("packages/worker-runtime/src/worker-task-pool-owned.ts");
const iterations = 5000;
const passes = 5;
const sourceHashes = {};
async function loadOwner(label, file, probe = false) {
  let source = readFileSync(file, "utf8");
  sourceHashes[label] = createHash("sha256").update(source).digest("hex");
  if (probe) {
    const declaration = "export function prepareWorkerTaskInput<";
    assert.equal(source.split(declaration).length, 2);
    source = source.replace(declaration, "function prepareWorkerTaskInputImpl<");
    source += `
export function prepareWorkerTaskInput(...args: Parameters<typeof prepareWorkerTaskInputImpl>) {
  globalThis.workerTaskInputProbe.before(args[0]);
  prepareWorkerTaskInputImpl(...args);
  globalThis.workerTaskInputProbe.after(args[0]);
}\n`;
  }
  const outfile = path.join(temporary, `${label}-${probe ? "probe" : "measure"}.mjs`);
  await build({
    entryPoints: ["packages/worker-runtime/src/worker-task-pool-core.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    plugins: [
      {
        name: "task-input-owner",
        setup(builder) {
          builder.onResolve(
            { filter: /^@openclaw\/normalization-core\// },
            ({ path: specifier }) => ({
              path: path.resolve(
                "packages/normalization-core/src",
                `${specifier.split("/").at(-1)}.ts`,
              ),
            }),
          );
          builder.onLoad({ filter: /\/worker-task-pool-owned\.ts$/ }, () => ({
            contents: source,
            loader: "ts",
            resolveDir: path.dirname(ownerPath),
          }));
        },
      },
    ],
  });
  return (await import(pathToFileURL(outfile).href)).WorkerTaskPoolCore;
}
class EchoWorker extends EventEmitter {
  threadId = 1;
  postMessage({ taskId, input }) {
    queueMicrotask(() => this.emit("message", { taskId, status: "ok", value: input }));
  }
  ref() {}
  unref() {}
  async terminate() {
    this.threadId = -1;
    this.emit("exit", 0);
  }
}
function createPool(Pool) {
  return new Pool(
    { workerUrl: new URL("file:///synthetic-task-worker.mjs"), maxWorkers: 1, idleTimeoutMs: 0 },
    {
      createWorker: () => ({ worker: new EchoWorker() }),
      serviceNativeWorkers() {},
      prepareResources: async () => {},
      releaseTemporaryDirectory: async () => {},
      captureTaskContext: () => undefined,
      receiveMessage: () => false,
      workerStarted() {},
      workerRetiring() {},
      pools: {
        register: (pool) => pool,
        async close(_pool, closures, finish) {
          await Promise.all(closures);
          await finish();
        },
      },
    },
  );
}
// Synthetic catalog reads across 10k sessions and 40 agents; inputs remain immutable.
const inputs = Array.from({ length: 100 }, (_, i) =>
  Object.freeze({
    kind: "query",
    agentId: `agent-${i % 40}`,
    sessionKey: `agent:${i % 40}:session:${i * 100}`,
    sql: "SELECT session_key, updated_at FROM sessions WHERE session_key = ?",
    params: Object.freeze([`session-${i * 100}`]),
  }),
);
async function run(pool, count, factory) {
  for (let i = 0; i < count; i++) {
    const input = inputs[i % inputs.length];
    assert.equal(await pool.run(factory ? () => input : input, { inputBytes: 256 }), input);
  }
}
const workCounts = {};
for (const [label, file] of [
  ["baseline", baselineFile],
  ["candidate", candidateFile],
]) {
  let before = 0,
    converted = 0,
    released = 0;
  globalThis.workerTaskInputProbe = {
    before(task) {
      assert(fast(task), "fixture must enter preparation with fast properties");
      before++;
    },
    after(task) {
      converted += Number(!fast(task));
      released += Number(task.input === undefined);
    },
  };
  const pool = createPool(await loadOwner(label, file, true));
  try {
    await run(pool, 100, false);
    await run(pool, 100, true);
  } finally {
    await pool.close();
  }
  workCounts[label] = { tasks: before, dictionaryConversions: converted, releasedInputs: released };
}
delete globalThis.workerTaskInputProbe;
console.log(JSON.stringify({ workCounts }));
assert.equal(
  workCounts.candidate.dictionaryConversions,
  0,
  "candidate preparation must not rebuild task property dictionaries",
);
assert.equal(workCounts.candidate.releasedInputs, workCounts.candidate.tasks);
const pools = {
  baseline: createPool(await loadOwner("baseline", baselineFile)),
  candidate: createPool(await loadOwner("candidate", candidateFile)),
};
const rows = [];
const inspector = new Session();
inspector.connect();
function bytes(node) {
  return node.selfSize + node.children.reduce((sum, child) => sum + bytes(child), 0);
}
try {
  for (const factory of [false, true]) {
    for (const pool of Object.values(pools)) {
      await run(pool, 1000, factory);
    }
    for (const mode of ["cpu", "allocation"]) {
      for (let pass = 0; pass < passes; pass++) {
        for (const label of pass % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
          globalThis.gc();
          if (mode === "allocation") {
            await inspector.post("HeapProfiler.startSampling", {
              samplingInterval: 512,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          }
          const hostLoad = loadavg();
          const cpu = process.cpuUsage();
          const started = performance.now();
          await run(pools[label], iterations, factory);
          const elapsedMs = performance.now() - started;
          const used = process.cpuUsage(cpu);
          const sampledBytes =
            mode === "allocation"
              ? bytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
              : undefined;
          rows.push({
            label,
            factory,
            mode,
            pass,
            iterations,
            hostLoad,
            elapsedMs,
            cpuMs: (used.user + used.system) / 1000,
            sampledBytes,
          });
        }
      }
    }
  }
} finally {
  inspector.disconnect();
  await Promise.all(Object.values(pools).map((pool) => pool.close()));
}
console.log(JSON.stringify({ node: process.version, sourceHashes, workCounts, rows }, null, 2));
