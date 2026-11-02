/**
 * Cold shared-state fallback-handler imports in fresh isolates, counterbalanced AB/BA.
 * node scripts/perf/state-read-import-bench.mjs --base /built/base --candidate /built/head \
 *   --output /new/report.json --pairs 5
 * Reuses worker-module-graphs-worker instrumentation: thread CPU, V8 allocated bytes,
 * and post-GC retained heap. Each sample imports the built production handler graph;
 * it does not execute queries or model production request frequency. Use the real
 * state-read-worker-bench.ts and team-shape-stress.ts workloads for those boundaries.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { MessageChannel, Worker } from "node:worker_threads";

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    candidate: { type: "string" },
    output: { type: "string" },
    pairs: { type: "string", default: "5" },
  },
});
assert(values.base && values.candidate && values.output, "--base, --candidate, --output required");
const pairs = Number(values.pairs);
assert(Number.isSafeInteger(pairs) && pairs > 0, "--pairs must be a positive integer");
const entries = Object.fromEntries(
  ["base", "candidate"].map((side) => {
    const directory = path.resolve(values[side], "dist/state");
    const files = readdirSync(directory).filter((file) =>
      /^openclaw-state-read-openclaw-state-read-handlers-[\w-]+\.mjs$/.test(file),
    );
    assert.equal(files.length, 1, `Expected one built state-read handler in ${directory}`);
    const entry = path.join(directory, files[0]);
    return [
      side,
      { entry, sha256: createHash("sha256").update(readFileSync(entry)).digest("hex") },
    ];
  }),
);
const results = [];
for (let pair = 0; pair < pairs; pair++) {
  for (const side of pair % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
    const { port1, port2 } = new MessageChannel();
    const hostLoad = loadavg();
    const worker = new Worker(new URL("./worker-module-graphs-worker.mjs", import.meta.url), {
      execArgv: ["--import", new URL("./team-shape-stress-loader.mjs", import.meta.url).href],
      workerData: {
        name: "state-read-handlers",
        entry: pathToFileURL(entries[side].entry).href,
        baselineFiles: [],
        diagnostics: port2,
      },
      transferList: [port2],
    });
    try {
      const value = await new Promise((resolve, reject) => {
        worker.once("error", reject);
        worker.once("exit", (code) =>
          reject(new Error(`Worker exited before measurement: ${code}`)),
        );
        port1.on("message", (message) => {
          if (message.ready) {
            port1.postMessage({ id: 1, operation: "inspect" });
          } else if (message.error) {
            reject(new Error(message.error));
          } else {
            resolve(message.value);
          }
        });
      });
      const row = {
        pair: pair + 1,
        side,
        hostLoad,
        hostLoadAfter: loadavg(),
        ...value.startup,
        retainedHeapBytes: value.heap.used_heap_size,
        code: value.code,
        scriptCount: value.scriptCount,
      };
      results.push(row);
      console.log(JSON.stringify(row));
    } finally {
      await worker.terminate();
      port1.close();
    }
  }
}
mkdirSync(path.dirname(path.resolve(values.output)), { recursive: true });
writeFileSync(values.output, JSON.stringify({ node: process.version, entries, results }, null, 2), {
  flag: "wx",
});
