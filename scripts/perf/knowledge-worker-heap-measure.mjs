// Measure actual Knowledge worker entrypoints and their request protocols, with synthetic stores.
// node --import ./scripts/tsx.mjs scripts/perf/knowledge-worker-heap-measure.mjs \
//   --state-dir .local/knowledge-measure --output .local/knowledge-measure.json
// --built --root <checkout> selects its dist entries/SDK. Run separate processes AB/BA.
// Source-only --baseline-dir <tree> substitutes storage-base.ts and storage-journal.ts;
// use C/A/A/C runs for warm comparisons. Source startup heap includes loader overhead.
// Natural heap is sampled before forced-GC retention diagnostics; neither is per-worker RSS.
// Startup and warm CPU/allocation are per isolate. This wrapper does not prove host labels.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { MessageChannel, Worker } from "node:worker_threads";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: fileURLToPath(new URL("../../", import.meta.url)) },
    "state-dir": { type: "string" },
    output: { type: "string" },
    built: { type: "boolean" },
    "baseline-dir": { type: "string" },
    iterations: { type: "string", default: "2000" },
    stores: { type: "string", default: "40" },
  },
});
assert(values["state-dir"] && values.output, "--state-dir and --output are required");
assert(!values.built || !values["baseline-dir"], "--baseline-dir is source-only");
const iterations = Number(values.iterations);
const storeCount = Number(values.stores);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(storeCount) && storeCount > 0 && storeCount <= 100);
const root = path.resolve(values.root);
assert(
  !values["baseline-dir"] ||
    root === path.resolve(fileURLToPath(new URL("../../", import.meta.url))),
  "--baseline-dir requires this script's checkout as --root",
);
await fs.mkdir(path.resolve(values["state-dir"]), { recursive: true });
const state = await fs.mkdtemp(path.join(path.resolve(values["state-dir"]), "run-"));
const prefix = values.built ? "dist" : "src";
const extension = values.built ? ".js" : ".ts";
const baselineFiles = values["baseline-dir"]
  ? ["extensions/knowledge/src/storage-base.ts", "extensions/knowledge/src/storage-journal.ts"]
  : [];
const baselineDir = path.join(state, "baseline");
const sdk = Object.fromEntries(
  ["database-engine-worker-runtime", "feature-contract", "routing", "sqlite-worker-runtime"].map(
    (name) => [
      `openclaw/plugin-sdk/${name}`,
      pathToFileURL(path.join(root, prefix, "plugin-sdk", `${name}${extension}`)).href,
    ],
  ),
);
const report = {
  node: process.version,
  root,
  built: Boolean(values.built),
  baseline: Boolean(values["baseline-dir"]),
  iterations,
  stores: storeCount,
  load: os.loadavg(),
  scope: "Synthetic Knowledge workers; startup/import and warm owner work, not Gateway throughput",
  results: [],
};

async function launch(name, config) {
  const diagnostics = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(8));
  const pending = new Map();
  const ready = Promise.withResolvers();
  let sequence = 0;
  let failure;
  const worker = new Worker(new URL("./worker-module-graphs-worker.mjs", import.meta.url), {
    execArgv: [
      "--import",
      new URL(values.built ? "./team-shape-stress-loader.mjs" : "../tsx.mjs", import.meta.url).href,
    ],
    env: { ...process.env, OPENCLAW_STATE_DIR: state, OPENCLAW_HOME: state, TMPDIR: state },
    workerData: {
      name: `knowledge-${name}`,
      entry: pathToFileURL(
        path.join(
          root,
          values.built ? "dist/extensions" : "extensions",
          "knowledge",
          "src",
          `${name}-worker${extension}`,
        ),
      ).href,
      sdk,
      files: { root: path.join(root, "extensions/knowledge"), extension },
      stateRoot: path.join(state, "knowledge"),
      config,
      signal: signal.buffer,
      diagnostics: diagnostics.port2,
      baselineFiles,
      baselineDir,
    },
    transferList: [diagnostics.port2],
  });
  const fail = (error) => {
    failure = error;
    ready.reject(error);
    for (const promise of pending.values()) {
      promise.reject(error);
    }
    pending.clear();
  };
  worker.on("error", fail);
  worker.on("exit", (code) => fail(new Error(`Knowledge ${name} worker exited (${code})`)));
  const timeout = setTimeout(
    () => fail(new Error(`Knowledge ${name} measurement timed out`)),
    180_000,
  );
  const receive = (message) => {
    if (message.ready) {
      ready.resolve();
      return;
    }
    if (message.type === "assert") {
      // Synthetic requests remain authorized until their real response; exercise the round trip.
      assert(pending.has(message.id), "authority request must belong to an outstanding operation");
      Atomics.store(signal, 1, 1);
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
      return;
    }
    const promise = pending.get(message.id);
    pending.delete(message.id);
    if (message.error || message.ok === false) {
      promise?.reject(new Error(message.error ?? message.message));
    } else {
      promise?.resolve(message.value);
    }
  };
  diagnostics.port1.on("message", receive);
  worker.on("message", receive);
  const request = (port, message) => {
    if (failure) {
      return Promise.reject(new Error(`Knowledge ${name} worker unavailable`, { cause: failure }));
    }
    const id = ++sequence;
    const promise = Promise.withResolvers();
    pending.set(id, promise);
    port.postMessage({ id, ...message });
    return promise.promise;
  };
  return {
    worker,
    ready: ready.promise,
    diagnostic: (operation) => request(diagnostics.port1, { operation }),
    call: (op, input) =>
      request(
        worker,
        name === "registry"
          ? { op, args: input ?? [] }
          : { type: "call", op, input, scope: { visibility: "private" }, agentId: "benchmark" },
      ),
    async close() {
      clearTimeout(timeout);
      await worker.terminate();
      diagnostics.port1.close();
    },
  };
}

async function measure(client, name, operation) {
  const coldNaturalHeap = await client.worker.getHeapStatistics();
  for (let i = 0; i < 32; i++) {
    await operation(i);
  }
  await client.diagnostic("begin");
  const started = performance.now();
  for (let i = 0; i < iterations; i++) {
    await operation(i);
  }
  const elapsedMs = performance.now() - started;
  const warm = await client.diagnostic("end");
  await delay(1000);
  const naturalHeap = await client.worker.getHeapStatistics();
  const retained = await client.diagnostic("retained");
  report.results.push({
    name,
    startup: retained.startup,
    coldNaturalHeap,
    naturalHeap,
    forcedGcHeap: retained.heap,
    scriptCount: retained.scriptCount,
    warm: { ...warm, elapsedMs, iterations },
    load: os.loadavg(),
  });
}

let registry;
let storage;
try {
  if (values["baseline-dir"]) {
    const { transform } = await import("esbuild");
    // The shared hook strips erasable TS; compile parameter properties before worker startup.
    for (const relative of baselineFiles) {
      const source = await fs.readFile(path.join(values["baseline-dir"], relative), "utf8");
      const target = path.join(baselineDir, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const compiled = await transform(source, { loader: "ts", format: "esm", target: "esnext" });
      await fs.writeFile(target, compiled.code);
    }
  }
  registry = await launch("registry");
  await registry.ready;
  let snapshot;
  for (let i = 0; i < storeCount; i++) {
    snapshot = await registry.call("provision", [`benchmark-${i}`]);
  }
  assert.equal(Object.keys(snapshot.stores).length, storeCount);
  await measure(registry, "registry", async () => {
    const result = await registry.call("snapshot");
    assert.equal(Object.keys(result.stores).length, storeCount);
  });
  const config = { ...snapshot.stores[snapshot.bindings["benchmark-0"]], writesEnabled: false };
  storage = await launch("storage", config);
  await storage.ready;
  await measure(storage, "storage", async (index) => {
    const result = await storage.call("sourceCheck", {
      provider: "benchmark",
      key: `synthetic-source-${index % 1000}`,
      sha256: "0".repeat(64),
    });
    assert.equal(result.state, "missing");
    assert.equal(result.receipt, null);
  });
  await fs.mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
  await fs.writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  await storage?.close();
  await registry?.close();
  await fs.rm(state, { recursive: true, force: true });
}
