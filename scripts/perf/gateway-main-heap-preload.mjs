/**
 * Opt-in cold-start diagnostic for an isolated synthetic Gateway only:
 * node --expose-gc --import ./scripts/perf/gateway-main-heap-preload.mjs dist/entry.js gateway run --port 41000 ...
 * After readiness and any desired RPCs, send SIGUSR2 to the owned Gateway PID.
 * Wait for <OPENCLAW_STATE_DIR>/main-heap-startup.json matching that PID before
 * stopping the Gateway. The capture includes post-GC
 * heap/RSS, loaded dependency scripts, main-thread CPU, sampled allocation and
 * host load. Run uninstrumented startup timing separately: inspector sampling
 * and forced GC change timings. Worker threads are excluded.
 */
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
if (isMainThread && process.argv.includes("gateway") && process.env.OPENCLAW_STATE_DIR) {
  if (!global.gc) {
    throw new Error("Gateway heap diagnostics require --expose-gc");
  }
  const inspector = new Session();
  inspector.connect();
  const scripts = new Set();
  inspector.on("Debugger.scriptParsed", ({ params }) => {
    if (params.url) {
      scripts.add(params.url);
    }
  });
  await inspector.post("Debugger.enable");
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  const hostLoad = loadavg();
  const capture = async () => {
    const cpuUsed = process.threadCpuUsage(cpu);
    const elapsedMs = performance.now() - start;
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    global.gc();
    const sum = (node) => node.selfSize + node.children.reduce((n, c) => n + sum(c), 0);
    const names = [
      "pi-tui",
      "acorn",
      "web-tree-sitter",
      "@modelcontextprotocol",
      "acpx",
      "@agentclientprotocol",
      "linkedom",
      "parse5",
      "htmlparser2",
      "entities",
      "micromark",
      "libopus",
    ];
    const modules = Object.fromEntries(
      names.map((name) => [name, [...scripts].filter((url) => url.includes(name))]),
    );
    writeFileSync(
      path.join(process.env.OPENCLAW_STATE_DIR, "main-heap-startup.json"),
      JSON.stringify({
        pid: process.pid,
        elapsedMs,
        cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
        allocationBytes: sum(profile.head),
        memory: process.memoryUsage(),
        scriptCount: scripts.size,
        scriptUrls: [...scripts],
        modules,
        hostLoad,
        hostLoadEnd: loadavg(),
      }),
    );
    inspector.disconnect();
  };
  process.once("SIGUSR2", () => {
    void capture();
  });
}
