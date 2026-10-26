import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  getHeapCodeStatistics,
  getHeapStatistics,
  setFlagsFromString,
  writeHeapSnapshot,
} from "node:v8";
import { isMainThread, workerData } from "node:worker_threads";

const replacedFiles = new Set([
  "src/agents/workspace-git.ts",
  "src/gateway/worker-environments/workspace-result-git.ts",
  "src/infra/git-exec.ts",
  "src/infra/sqlite-staging-token.ts",
  "src/plugins/plugin-generation-preparation.worker.ts",
  "src/skills/loading/plugin-skills.ts",
]);

// Keep resolution at the candidate URL: only these source bytes differ between sides.
export function installBaselineHook(directory, files = replacedFiles) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  registerHooks({
    load(url, context, next) {
      if (url.startsWith("file:")) {
        const relative = path.relative(root, fileURLToPath(url));
        if (files.has(relative)) {
          return {
            format: "module",
            source: stripTypeScriptTypes(
              fs.readFileSync(path.join(directory ?? root, relative), "utf8"),
            ),
            shortCircuit: true,
          };
        }
      }
      return next(url, context);
    },
  });
}

export function distribution(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (percentile) => sorted[Math.ceil(sorted.length * percentile) - 1] ?? null;
  return {
    count: sorted.length,
    total: sorted.reduce((sum, sample) => sum + sample, 0),
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1) ?? null,
  };
}

if (!isMainThread) {
  installBaselineHook(
    workerData.baselineDir,
    workerData.baselineFiles ? new Set(workerData.baselineFiles) : undefined,
  );
  const inspector = new Session();
  inspector.connect();
  const port = workerData.diagnostics;
  const loop = monitorEventLoopDelay({ resolution: 1 });
  let active = false;
  let cpuStart;
  let allocationStart;
  let measuredAfter = Infinity;
  let samples = [];
  const record = (entries) => {
    if (active) {
      samples.push(
        ...entries
          .filter((entry) => entry.startTime >= measuredAfter)
          .map((entry) => ({ kind: entry.detail.kind, ms: entry.duration })),
      );
    }
  };
  const observer = new PerformanceObserver((list) => record(list.getEntries()));
  observer.observe({ entryTypes: ["gc"] });
  await import(workerData.entry);
  port.on("message", async ({ id, operation, snapshot }) => {
    try {
      let value;
      if (operation === "prepare") {
        if (workerData.traceGc) {
          fs.writeSync(1, `WORKER_GC_IDENTIFY_BEGIN ${workerData.name}\n`);
          setFlagsFromString("--trace-gc-nvp");
          await inspector.post("HeapProfiler.collectGarbage");
          setFlagsFromString("--no-trace-gc-nvp");
          fs.writeSync(1, `WORKER_GC_IDENTIFY_END ${workerData.name}\n`);
        }
        value = { prepared: true };
      } else if (operation === "begin") {
        observer.takeRecords();
        samples = [];
        loop.reset();
        loop.enable();
        cpuStart = process.threadCpuUsage();
        allocationStart = getHeapStatistics().total_allocated_bytes;
        if (!Number.isFinite(allocationStart)) {
          throw new Error("Allocation measurement requires V8 total_allocated_bytes (Node 26.12+)");
        }
        if (workerData.sampleAllocation) {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 16384,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        measuredAfter = performance.now();
        active = true;
        fs.writeSync(1, `WORKER_GC_BEGIN ${workerData.name}\n`);
        if (workerData.traceGc) {
          setFlagsFromString("--trace-gc-nvp");
        }
        value = { started: true };
      } else if (operation === "end") {
        record(observer.takeRecords());
        active = false;
        loop.disable();
        if (workerData.traceGc) {
          setFlagsFromString("--no-trace-gc-nvp");
        }
        fs.writeSync(1, `WORKER_GC_END ${workerData.name}\n`);
        const cpu = process.threadCpuUsage(cpuStart);
        const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocationStart;
        if (workerData.sampleAllocation) {
          const { profile } = await inspector.post("HeapProfiler.stopSampling");
          fs.writeFileSync(workerData.sampleAllocation, JSON.stringify(profile));
        }
        value = {
          cpuMs: (cpu.user + cpu.system) / 1000,
          allocatedBytes,
          gc: {
            all: distribution(samples.map((sample) => sample.ms)),
            minor: distribution(
              samples
                .filter((sample) => sample.kind === constants.NODE_PERFORMANCE_GC_MINOR)
                .map((sample) => sample.ms),
            ),
            major: distribution(
              samples
                .filter((sample) => sample.kind === constants.NODE_PERFORMANCE_GC_MAJOR)
                .map((sample) => sample.ms),
            ),
          },
          eventLoopMs: {
            count: loop.count,
            p95: loop.count ? loop.percentile(95) / 1e6 : null,
            p99: loop.count ? loop.percentile(99) / 1e6 : null,
            max: loop.count ? loop.max / 1e6 : null,
          },
        };
      } else {
        await inspector.post("HeapProfiler.collectGarbage");
        const heap = getHeapStatistics();
        const code = getHeapCodeStatistics();
        const memory = process.memoryUsage();
        if (snapshot) {
          writeHeapSnapshot(snapshot);
        }
        const scripts = new Map();
        const parsed = ({ params }) => scripts.set(params.scriptId, params.url);
        inspector.on("Debugger.scriptParsed", parsed);
        await inspector.post("Debugger.enable");
        await inspector.post("Debugger.disable");
        inspector.off("Debugger.scriptParsed", parsed);
        const modules = [
          ...new Set([...scripts.values()].filter((url) => url.startsWith("file:"))),
        ];
        value = {
          heap,
          code,
          memory,
          scriptCount: modules.length,
          compiledScriptCount: scripts.size,
          scripts: modules.toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
          ...(snapshot ? { snapshot } : {}),
        };
      }
      port.postMessage({ id, value });
    } catch (error) {
      port.postMessage({ id, error: String(error?.stack ?? error) });
    }
  });
  port.postMessage({ ready: true });
}
