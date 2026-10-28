/**
 * Real idle-expiry probe for Code Mode and Git content owners, with synthetic data only.
 * node --import ./scripts/tsx.mjs scripts/perf/worker-warm-floor-measure.mjs \
 *   --output .local/warm-floor/candidate.json --expect-floor
 * Baseline: omit --expect-floor and add --baseline-dir <source-overlay-directory>.
 * Run arms serially in AB/BA order with the SAME --built-root (default cwd).
 * Overlay the five owner files listed below using their repository-relative paths.
 * --gap-ms defaults to 310000 (must exceed 300000); --iterations defaults to 1000.
 * One real idle gap tests both owners; tails from its single cold call are not inferred.
 * Worker entries are hashed; retain the same build and shared chunks between arms.
 * Source-host cold work may include tooling compilation. Post-idle/warm work reuses it.
 * CPU/allocations include owner calls; native counters include bootstrap and probes.
 * Heap is unforced usage, RSS is process-wide, and Git subprocess CPU is excluded.
 * This is owner-path proof, not a full Gateway or a production arrival reconstruction.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { transformSync } from "esbuild";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "baseline-dir": { type: "string" },
    "built-root": { type: "string", default: process.cwd() },
    "gap-ms": { type: "string", default: "310000" },
    iterations: { type: "string", default: "1000" },
    "expect-floor": { type: "boolean", default: false },
  },
});
assert(values.output, "--output is required");
const gapMs = Number(values["gap-ms"]),
  iterations = Number(values.iterations);
assert(
  Number.isSafeInteger(gapMs) && gapMs > 300000,
  "--gap-ms must exceed the old five-minute expiry",
);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.resolve(values.output),
  builtRoot = path.resolve(values["built-root"]);
const ownerFiles = [
  "src/agents/code-mode-node.ts",
  "src/infra/git-worker.ts",
  "packages/worker-runtime/src/worker-task-pool-core.ts",
  "packages/worker-runtime/src/worker-task-pool-retirement.ts",
  "packages/worker-runtime/src/worker-task-pool.types.ts",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sources = new Map(
  ownerFiles.map((file) => [
    pathToFileURL(path.join(root, file)).href,
    fs.readFileSync(path.join(values["baseline-dir"] ?? root, file), "utf8"),
  ]),
);
const overlay = values["baseline-dir"]
  ? new Map(
      [...sources].map(([url, source]) => [
        url,
        transformSync(source, {
          loader: "ts",
          format: "esm",
          target: "esnext",
          tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
        }).code,
      ]),
    )
  : undefined;
const declaration = new URL("../../src/infra/runtime-process-entrypoints.ts", import.meta.url).href;
const builtDeclaration = pathToFileURL(
  path.join(builtRoot, "dist/infra/runtime-process-entrypoints.js"),
).href;
registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    return resolved.url === declaration ? { ...resolved, url: builtDeclaration } : resolved;
  },
  load(url, context, next) {
    return overlay?.has(url)
      ? {
          format: "module",
          source: overlay.get(url),
          shortCircuit: true,
        }
      : next(url, context);
  },
});
fs.mkdirSync(path.dirname(output), { recursive: true });
const scratch = fs.mkdtempSync(path.join(path.dirname(output), "worker-warm-floor-"));
for (const directory of ["home", "state", "tmp", "repo"]) {
  fs.mkdirSync(path.join(scratch, directory));
}
Object.assign(process.env, {
  HOME: path.join(scratch, "home"),
  OPENCLAW_HOME: path.join(scratch, "home"),
  OPENCLAW_STATE_DIR: path.join(scratch, "state"),
  TMPDIR: path.join(scratch, "tmp"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  ...(process.platform === "darwin"
    ? { DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" }
    : {}),
});
const repo = path.join(scratch, "repo");
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
git("init", "--template=", "-q", "-b", "main");
git(
  "-c",
  "user.name=Benchmark",
  "-c",
  "user.email=benchmark@example.invalid",
  "commit",
  "--allow-empty",
  "-qm",
  "synthetic",
);
const { nodeCodeModeExecutor } = await import("../../src/agents/code-mode-node.ts");
const { prepareCodeModeNodeCatalog } = await import("../../src/agents/code-mode-node-input.ts");
const { LegacyPluginSdkResourceHost } =
  await import("../../src/plugins/legacy-sdk-resource-host.ts");
const { GatewayScheduler } = await import("../../src/infra/gateway-scheduler.ts");
const { runGitWorkerOperation } = await import("../../src/infra/git-worker.ts");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.ts");
const { getTrackedWorkerLifecycleSnapshot, sampleTrackedWorkerMemory } =
  await import("../../src/infra/worker-cpu.ts");
const host = new LegacyPluginSdkResourceHost(),
  scheduler = new GatewayScheduler();
host.bindScheduler(scheduler);
const scripts = { code: "code-mode-node.worker.js", git: "git-operation.worker.js" };
const workerFiles = {
  code: "dist/agents/code-mode-node.worker.js",
  git: "dist/infra/git-operation.worker.js",
};
const report = {
  node: process.version,
  sourceHead: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  builtRoot,
  baselineOverlay: Boolean(values["baseline-dir"]),
  expectFloor: values["expect-floor"],
  gapMs,
  iterations,
  ownerHashes: Object.fromEntries(
    ownerFiles.map((file) => [file, hash(sources.get(pathToFileURL(path.join(root, file)).href))]),
  ),
  workerHashes: Object.fromEntries(
    Object.entries(workerFiles).map(([kind, file]) => [
      kind,
      hash(fs.readFileSync(path.join(builtRoot, file))),
    ]),
  ),
  events: [],
};
const persist = () => fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
const workers = [];
const onWorker = (worker) => {
  const entry = { worker, threadId: worker.threadId };
  workers.push(entry);
  worker.once("exit", () => {
    entry.exited = true;
  });
};
process.on("worker", onWorker);
await setImmediate(); // Drain delayed creation events from the source tooling helper.
const lifecycle = (kind) =>
  getTrackedWorkerLifecycleSnapshot().workerLifecycle.find((row) => row.script === scripts[kind]);
const started = (kind) => lifecycle(kind)?.started ?? 0;
function relevantWorkers(kind) {
  const memory = sampleTrackedWorkerMemory({ refresh: false });
  const byId = new Map(
    [...memory.workerHeaps, ...memory.workerMemoryMissing].map((row) => [row.threadId, row.script]),
  );
  for (const entry of workers) {
    entry.script ??= byId.get(entry.threadId);
  }
  return workers.filter(
    (entry) =>
      !entry.exited &&
      (kind ? entry.script === scripts[kind] : Object.values(scripts).includes(entry.script)),
  );
}
const sumCpu = (cpu) => (cpu.user + cpu.system) / 1000;
async function native(kind) {
  return Promise.all(
    relevantWorkers(kind).map(async ({ worker, threadId, script }) => ({
      threadId,
      script,
      cpuMs: sumCpu(await worker.cpuUsage()),
      heap: await worker.getHeapStatistics(),
    })),
  );
}
async function census(label) {
  report.events.push({
    label,
    at: performance.now(),
    processRssBytes: process.memoryUsage.rss(),
    workers: await native(),
    lifecycle: Object.keys(scripts).map(lifecycle),
    hostLoad: loadavg(),
  });
  persist();
}
const config = {
  timeoutMs: 30000,
  memoryLimitBytes: 470 * 1024 * 1024,
  maxOutputBytes: 16384,
  maxSnapshotBytes: 65536,
  maxPendingToolCalls: 128,
};
const catalog = prepareCodeModeNodeCatalog({
  catalog: Array.from({ length: 160 }, (_, index) => ({
    name: `tool_${index}`,
    callableName: `tool_${index}`,
    source: "openclaw",
    description: "Synthetic tool metadata ".repeat(8),
  })),
  namespaces: [],
});
async function execute(kind) {
  if (kind === "git") {
    const reply = await runGitWorkerOperation({
      type: "checkout.diff",
      input: { cwd: repo, scope: "uncommitted" },
    });
    assert.deepEqual(reply.files, []);
  } else {
    const reply = await host.run(() =>
      nodeCodeModeExecutor.execute(
        { kind: "exec", source: "return await tool_0({value:8128});", config, ...catalog },
        {
          timeoutMs: 30000,
          inlineHost: {
            async onBoundary(boundary, context) {
              assert.equal(boundary.pendingRequests.length, 1);
              const request = boundary.pendingRequests[0];
              assert.equal(request.args[0], "tool_0");
              return {
                kind: "continue",
                timeoutMs: context.maxTimeoutMs,
                pendingRequests: [],
                settledRequests: [
                  { id: request.id, ok: true, json: JSON.stringify(request.args[1]) },
                ],
              };
            },
          },
        },
      ),
    );
    assert.equal(reply.status, "completed", JSON.stringify(reply));
    assert.equal(reply.value.json, '{"value":8128}');
  }
}
async function phase(kind, label, count = 1) {
  const beforeNative = new Map((await native(kind)).map((row) => [row.threadId, row]));
  const starts = started(kind),
    cpu = process.threadCpuUsage(),
    allocation = getHeapStatistics().total_allocated_bytes;
  assert(Number.isFinite(allocation), "Node with total_allocated_bytes is required");
  const rss = process.memoryUsage.rss(),
    at = performance.now(),
    latencies = [];
  for (let index = 0; index < count; index++) {
    const taskAt = performance.now();
    await execute(kind);
    latencies.push(performance.now() - taskAt);
  }
  const row = {
    kind,
    label,
    iterations: count,
    wallMs: performance.now() - at,
    mainCpuMs: sumCpu(process.threadCpuUsage(cpu)),
    mainAllocatedBytes: getHeapStatistics().total_allocated_bytes - allocation,
    processRssDeltaBytes: process.memoryUsage.rss() - rss,
    spawns: started(kind) - starts,
    hostLoad: loadavg(),
  };
  const afterNative = await native(kind);
  assert.equal(afterNative.length, 1, `${kind}: expected one live worker`);
  for (const threadId of beforeNative.keys()) {
    assert(
      afterNative.some((worker) => worker.threadId === threadId),
      "Worker exited during measured work",
    );
  }
  row.workerCpuMs = afterNative.reduce(
    (sum, worker) => sum + worker.cpuMs - (beforeNative.get(worker.threadId)?.cpuMs ?? 0),
    0,
  );
  row.workerAllocatedBytes = afterNative.reduce(
    (sum, worker) =>
      sum +
      worker.heap.total_allocated_bytes -
      (beforeNative.get(worker.threadId)?.heap.total_allocated_bytes ?? 0),
    0,
  );
  assert(Number.isFinite(row.workerAllocatedBytes));
  latencies.sort((a, b) => a - b);
  row.latencyMs = {
    samples: count,
    min: latencies[0],
    median: (latencies[Math.floor((count - 1) / 2)] + latencies[Math.floor(count / 2)]) / 2,
    max: latencies.at(-1),
    ...(count >= 200 ? { p95: latencies[Math.ceil(count * 0.95) - 1] } : {}),
    ...(count >= 1000 ? { p99: latencies[Math.ceil(count * 0.99) - 1] } : {}),
  };
  report.events.push(row);
  persist();
  console.log(JSON.stringify(row));
  return row;
}
async function waitForNoWorkers() {
  const deadline = performance.now() + 30000;
  while (relevantWorkers().length && performance.now() < deadline) {
    await delay(20);
  }
  assert.equal(relevantWorkers().length, 0, "Native workers did not exit within 30s");
}
async function boundedClose() {
  let timer;
  try {
    await Promise.race([
      (async () => {
        await host.close();
        await scheduler.stop();
        await drainGlobalSingletonLifecycleState("close");
        await waitForNoWorkers();
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Owner cleanup exceeded 60s")), 60000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const keepAlive = setInterval(() => {}, 1000);
let closed = false;
try {
  for (const kind of Object.keys(scripts)) {
    assert.equal((await phase(kind, "cold")).spawns, 1);
    await phase(kind, "warmup", 3);
  }
  await census("before-idle");
  const gapStarted = performance.now();
  await delay(gapMs);
  report.events.push({
    label: "idle-gap",
    wallMs: performance.now() - gapStarted,
    hostLoad: loadavg(),
  });
  await census("after-idle");
  for (const kind of Object.keys(scripts)) {
    assert.equal(
      relevantWorkers(kind).length,
      values["expect-floor"] ? 1 : 0,
      `${kind}: unexpected idle retention`,
    );
    assert.equal((await phase(kind, "after-idle")).spawns, values["expect-floor"] ? 0 : 1);
    assert.equal((await phase(kind, "warm", iterations)).spawns, 0);
  }
  await census("after-work");
  const pressureAt = performance.now();
  channel("openclaw.memory.critical").publish({});
  await waitForNoWorkers();
  report.events.push({
    label: "pressure-eviction",
    wallMs: performance.now() - pressureAt,
    relevantWorkers: 0,
  });
  for (const kind of Object.keys(scripts)) {
    assert.equal((await phase(kind, "after-pressure")).spawns, 1);
  }
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  const at = performance.now();
  try {
    await boundedClose();
    closed = true;
  } catch (error) {
    report.cleanupError = String(error);
    process.exitCode = 1;
  } finally {
    report.events.push({
      label: "cleanup",
      wallMs: performance.now() - at,
      relevantWorkers: relevantWorkers().length,
      complete: closed,
    });
    persist();
    clearInterval(keepAlive);
    process.off("worker", onWorker);
    if (closed) {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}
