/**
 * Cold-load the built read-tool owner, then construct 5,000 headless tools.
 * Run each arm in a fresh process, counterbalancing base/candidate order:
 *   node --expose-gc scripts/perf/headless-tools-cold-import.mjs <tools-chunk.mjs> <createReadTool-export> [iterations]
 * Find the chunk/export in dist via `rg 'createReadTool as' dist/tools-*.mjs`.
 * Reports main-thread CPU, sampled allocation including collected objects,
 * post-GC retained bytes and parsed script counts. Inspector overhead applies
 * equally to both arms; this owner probe does not replace Gateway startup proof.
 */
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [chunk, exportName, count = "5000"] = process.argv.slice(2);
const iterations = Number(count);
if (!chunk || !exportName || !Number.isSafeInteger(iterations) || iterations < 1 || !global.gc) {
  throw new Error(
    "Expected --expose-gc, a built tools chunk, its createReadTool export, and a positive iteration count",
  );
}
const inspector = new Session();
inspector.connect();
try {
  const scripts = new Set();
  inspector.on("Debugger.scriptParsed", ({ params }) => {
    if (params.url) {
      scripts.add(params.url);
    }
  });
  await inspector.post("Debugger.enable");
  global.gc();
  const initialHeap = process.memoryUsage().heapUsed;
  const hostLoad = loadavg();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const started = performance.now();
  const cpu = process.threadCpuUsage();
  const { [exportName]: createReadTool } = await import(pathToFileURL(resolve(chunk)).href);
  if (typeof createReadTool !== "function") {
    throw new Error("Missing createReadTool export");
  }
  for (let i = 0; i < iterations; i++) {
    createReadTool("/synthetic");
  }
  const cpuUsed = process.threadCpuUsage(cpu);
  const elapsedMs = performance.now() - started;
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  global.gc();
  const memory = process.memoryUsage();
  const sampledBytes = (node) =>
    node.selfSize + node.children.reduce((n, child) => n + sampledBytes(child), 0);
  console.log(
    JSON.stringify({
      chunk: resolve(chunk),
      iterations,
      elapsedMs,
      cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
      allocationBytes: sampledBytes(profile.head),
      retainedBytes: memory.heapUsed - initialHeap,
      memory,
      scriptCount: scripts.size,
      terminalScriptCount: [...scripts].filter((url) => url.includes("/pi-tui/")).length,
      hostLoad,
      hostLoadEnd: loadavg(),
    }),
  );
} finally {
  inspector.disconnect();
}
