// Synthetic owner proof on Node 26: node --import ./scripts/tsx.mjs scripts/perf/session-transcript-code-measure.mjs --output <owned-dir> [--baseline-dir <original-source-tree>] [--samples 5]
// Each pair alternates base/candidate order. --control loads baseline bytes for both sides.
// --snapshots captures the first pair only; baseline overrides only the three edited sources;
// all other modules resolve from the same checkout. Snapshots force GC outside latency windows.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MessageChannel, Worker } from "node:worker_threads";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "baseline-dir": { type: "string" },
    samples: { type: "string", default: "5" },
    control: { type: "boolean", default: false },
    snapshots: { type: "boolean", default: false },
  },
});
assert(values.output, "--output is required");
assert(!values.control || values["baseline-dir"], "--control requires --baseline-dir");
const output = path.resolve(values.output);
const samples = Number(values.samples);
assert(Number.isSafeInteger(samples) && samples > 0);
await fs.mkdir(output, { recursive: true });
for (const directory of ["home", "state", "tmp"]) {
  await fs.mkdir(path.join(output, directory), { recursive: true });
}
const baselineFiles = [
  "src/agents/bash-tools.process-schema.ts",
  "src/infra/agent-activity-events.ts",
  "src/shared/text/assistant-visible-text.ts",
];
const results = [];
for (let sample = 0; sample < samples; sample++) {
  const sides = values["baseline-dir"]
    ? sample % 2
      ? ["candidate", "baseline"]
      : ["baseline", "candidate"]
    : ["candidate"];
  for (const side of sides) {
    const diagnostics = new MessageChannel();
    const tasks = new MessageChannel();
    const ready = Promise.withResolvers();
    const taskReady = Promise.withResolvers();
    const pending = new Map();
    let sequence = 0;
    void taskReady.promise.catch(() => {});
    const started = performance.now();
    const worker = new Worker(new URL("./worker-module-graphs-worker.mjs", import.meta.url), {
      workerData: {
        name: "session-transcript",
        entry: new URL("../../src/config/sessions/session-transcript.worker.ts", import.meta.url)
          .href,
        prewarmHistory: true,
        diagnostics: diagnostics.port2,
        baselineDir:
          values.control || side === "baseline" ? path.resolve(values["baseline-dir"]) : undefined,
        baselineFiles,
      },
      transferList: [diagnostics.port2],
      env: {
        PATH: process.env.PATH,
        HOME: path.join(output, "home"),
        OPENCLAW_HOME: path.join(output, "home"),
        OPENCLAW_STATE_DIR: path.join(output, "state"),
        TMPDIR: path.join(output, "tmp"),
      },
    });
    const fail = (error) => {
      ready.reject(error);
      taskReady.reject(error);
      for (const promise of pending.values()) {
        promise.reject(error);
      }
    };
    worker.on("error", fail);
    const timeout = setTimeout(() => fail(new Error("Worker measurement timed out")), 120000);
    diagnostics.port1.on("message", (message) => {
      if (message.ready) {
        ready.resolve();
      } else {
        const promise = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          promise?.reject(new Error(message.error));
        } else {
          promise?.resolve(message.value);
        }
      }
    });
    tasks.port1.on("message", (message) => {
      if (message.status === "ready") {
        taskReady.resolve();
      } else {
        const promise = pending.get(message.taskId);
        pending.delete(message.taskId);
        if (message.status === "ok") {
          promise?.resolve(message.value);
        } else {
          promise?.reject(new Error(message.error));
        }
      }
    });
    try {
      await ready.promise;
      worker.postMessage({ type: "openclaw.worker-task-port", port: tasks.port2 }, [tasks.port2]);
      await taskReady.promise;
      const coldReadyMs = performance.now() - started;
      const id = ++sequence;
      const task = Promise.withResolvers();
      pending.set(id, task);
      const taskStarted = performance.now();
      tasks.port1.postMessage({
        taskId: id,
        input: {
          kind: "prewarm",
          env: {},
          database: { agentId: "main", path: path.join(output, "missing.sqlite") },
        },
        interactive: true,
        nativeSections: new SharedArrayBuffer(4),
        taskContext: { deletedAgentDatabaseFences: [] },
      });
      const reply = await task.promise;
      const firstTaskMs = performance.now() - taskStarted;
      assert.equal(reply.ok, true);
      assert.deepEqual(reply.value, { kind: "prewarm" });
      const inspect = Promise.withResolvers();
      pending.set(++sequence, inspect);
      diagnostics.port1.postMessage({
        id: sequence,
        operation: "inspect",
        ...(sample === 0 && values.snapshots
          ? { snapshot: path.join(output, `${side}.heapsnapshot`) }
          : {}),
      });
      const retained = await inspect.promise;
      if (sample === 0) {
        const names = retained.scripts.flatMap((url) => {
          const parsed = new URL(url);
          parsed.search = "";
          parsed.hash = "";
          return [parsed.href, fileURLToPath(parsed)];
        });
        await fs.writeFile(path.join(output, `${side}-scripts.txt`), names.join("\n") + "\n");
      }
      results.push({ sample, side, coldReadyMs, firstTaskMs, ...retained });
      await fs.writeFile(
        path.join(output, "results.json"),
        JSON.stringify({ node: process.version, results }, null, 2),
      );
      console.log(
        JSON.stringify({
          sample,
          side,
          coldReadyMs,
          firstTaskMs,
          heapBytes: retained.heap.used_heap_size,
          code: retained.code,
          scripts: retained.scriptCount,
        }),
      );
    } finally {
      clearTimeout(timeout);
      await worker.terminate();
      diagnostics.port1.close();
      tasks.port1.close();
    }
  }
}
