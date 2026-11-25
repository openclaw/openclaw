// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/widget-script-syntax-measure.ts \
//   --baseline <baseline widget-script-syntax.ts> [--candidate <candidate module>]
// Add --allocation or --cpu-profile with --profiles <directory> for diagnostic passes.
// Add --tool and use widget-tool.ts modules to measure execute() with a synthetic presenter.
// For packaged-worker startup, use --baseline src/canvas/widget-script-parse.ts
// --worker-entry dist/canvas/widget-script-syntax.worker.js in five fresh processes.
// Keep the baseline module inside its checkout so its package imports resolve unchanged.
// This measures the syntax owner, not Gateway transport, model latency, or document storage.
// Acceptance: identical diagnostics; eliminate repeat parses; large unique scripts no longer
// occupy the main thread for the parse (target <10 ms main-thread CPU per call).
// Report worker startup, total CPU, wall latency, and allocations separately; do not hide
// cold-start or >20% total-cost regressions behind the responsiveness improvement.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Worker } from "node:worker_threads";
import type { WidgetScript, parseWidgetScript } from "../../src/canvas/widget-script-parse.js";
import type { WorkerTaskPool } from "../../src/infra/worker-task-pool.js";
import { GatewayBenchWorkerProfiler } from "../lib/gateway-bench-worker-profile.ts";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    candidate: { type: "string", default: "src/canvas/widget-script-syntax.ts" },
    samples: { type: "string", default: "7" },
    calls: { type: "string", default: "10" },
    allocation: { type: "boolean", default: false },
    tool: { type: "boolean", default: false },
    profiles: { type: "string" },
    "cpu-profile": { type: "boolean", default: false },
    "worker-entry": { type: "string" },
  },
});
if (!values.baseline) {
  throw new Error("--baseline must name the original syntax-owner module");
}
const samples = parseStrictIntegerOption({
  raw: values.samples,
  label: "--samples",
  min: 5,
  fallback: 7,
});
const calls = parseStrictIntegerOption({
  raw: values.calls,
  label: "--calls",
  min: 1,
  fallback: 10,
});
type Diagnostic = {
  message: string;
  line: number;
  column: number;
  snippet: string;
  scriptIndex: number;
};
type Reply = Diagnostic | string | ReturnType<typeof parseWidgetScript>;
type Check = (html: string) => Reply | Promise<Reply>;
async function loadCheck(file: string): Promise<Check> {
  const module = await import(pathToFileURL(path.resolve(file)).href);
  if (values["worker-entry"]) {
    assert.equal(values.tool, false, "--worker-entry measures raw scripts, not the tool");
    return (body) => module.parseWidgetScript({ body, sourceType: "script" });
  }
  if (!values.tool) {
    return module.findWidgetScriptSyntaxError;
  }
  const tool = module.createShowWidgetTool({
    inlineClientAvailable: false,
    presenters: [
      {
        target: "current_channel",
        description: "Synthetic benchmark presenter",
        capabilities: { sourceKinds: ["html"] },
        match: () => true,
        availability: async () => ({ ok: true, value: { available: true } }),
        present: async () => ({
          ok: true,
          value: {
            kind: "message",
            receipt: {
              primaryPlatformMessageId: "synthetic",
              platformMessageIds: ["synthetic"],
              parts: [],
              sentAt: 1,
            },
          },
        }),
      },
    ],
  });
  return async (html) => {
    try {
      const result = await tool.execute("synthetic-widget", {
        title: "Synthetic chart",
        widget_code: html,
      });
      assert.equal(JSON.parse(result.content[0].text).kind, "widget");
      return undefined;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("widget_code has a JavaScript syntax error")
      ) {
        return error.message;
      }
      throw error;
    }
  };
}
const inspector = new Session();
const profiling = values.allocation || values["cpu-profile"];
const workerProfiler = profiling ? new GatewayBenchWorkerProfiler(inspector) : undefined;
// Inspector messages to an idle, unref'ed pool worker do not keep Node alive.
const profilingKeepalive = profiling ? setInterval(() => {}, 1000) : undefined;
const workers = new Set<Worker>();
const onWorker = (worker: Worker) => workers.add(worker);
process.on("worker", onWorker);
let captureIndex = 0;
if (profiling) {
  if (!values.profiles) {
    throw new Error("Profiling requires --profiles <directory> for per-thread evidence");
  }
  await mkdir(values.profiles, { recursive: true });
  inspector.connect();
}
const baseline = await loadCheck(values.baseline);
let packagedPool: WorkerTaskPool<WidgetScript, ReturnType<typeof parseWidgetScript>> | undefined;
const workerEntry = values["worker-entry"];
const WorkerPool = workerEntry
  ? (await import("../../src/infra/worker-task-pool.js")).WorkerTaskPool
  : undefined;
const candidate: Check =
  WorkerPool && workerEntry
    ? (body) => {
        packagedPool ??= new WorkerPool({
          workerUrl: pathToFileURL(path.resolve(workerEntry)),
          workerClass: "compute",
          sharedCompute: true,
        });
        return packagedPool.run({ body, sourceType: "script" }, { inputBytes: body.length * 2 });
      }
    : await loadCheck(values.candidate);

function widget(bytes: number, revision: string) {
  const prefix = `${values["worker-entry"] ? "" : '<canvas id="chart"></canvas><script>\n'}const ctx = document.getElementById("chart").getContext("2d");\n/*${revision}*/\n`;
  const draw = 'ctx.fillStyle = "#336699"; ctx.fillRect(12, 24, 32, 48);\n';
  const suffix = values["worker-entry"] ? "" : "\n</script>";
  const count = Math.floor((bytes - prefix.length - suffix.length) / draw.length);
  const body = prefix + draw.repeat(count);
  return body + " ".repeat(bytes - body.length - suffix.length) + suffix;
}

async function measure(check: Check, inputs: string[]) {
  globalThis.gc?.();
  await immediate();
  const profilePath = path.join(values.profiles ?? ".", `capture-${captureIndex++}`);
  if (values.allocation) {
    await workerProfiler?.start("heap", profilePath, {
      samplingIntervalBytes: 1024,
      includeCollectedObjects: true,
    });
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const observations = [];
  const cpuBefore = process.cpuUsage();
  const threadBefore = process.threadCpuUsage();
  const memoryBefore = process.memoryUsage();
  for (const input of inputs) {
    let previousTick = performance.now();
    let longestGapMs = 0;
    const heartbeat = setInterval(() => {
      const now = performance.now();
      longestGapMs = Math.max(longestGapMs, now - previousTick);
      previousTick = now;
    }, 1);
    const started = performance.now();
    const pending = check(input);
    const synchronousMs = performance.now() - started;
    assert.equal(await pending, undefined);
    const elapsedMs = performance.now() - started;
    // Let the timer observe synchronous calls as well as calls which yielded to a worker.
    await delay(0);
    clearInterval(heartbeat);
    observations.push({ elapsedMs, synchronousMs, longestGapMs });
  }
  const cpu = process.cpuUsage(cpuBefore);
  const thread = process.threadCpuUsage(threadBefore);
  const memoryAfter = process.memoryUsage();
  const allocatedBytes = values.allocation
    ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  let workerAllocatedBytes = 0;
  if (values.allocation) {
    await workerProfiler?.stop("heap");
    const captures = JSON.parse(await readFile(`${profilePath}.workers.json`, "utf8"));
    for (const worker of captures.workers) {
      assert.equal(worker.error, undefined);
      assert.equal(worker.completed, true);
      const profile = JSON.parse(await readFile(worker.profilePath, "utf8"));
      workerAllocatedBytes += sumSampledHeapBytes(profile.head);
    }
  }
  return {
    observations,
    cpuMsPerCall: (cpu.user + cpu.system) / 1000 / inputs.length,
    mainThreadCpuMsPerCall: (thread.user + thread.system) / 1000 / inputs.length,
    mainThreadAllocatedBytesPerCall:
      allocatedBytes === undefined ? undefined : allocatedBytes / inputs.length,
    workerAllocatedBytesPerCall:
      allocatedBytes === undefined ? undefined : workerAllocatedBytes / inputs.length,
    totalAllocatedBytesPerCall:
      allocatedBytes === undefined
        ? undefined
        : (allocatedBytes + workerAllocatedBytes) / inputs.length,
    heapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
    externalDeltaBytes: memoryAfter.external - memoryBefore.external,
    rssBytes: memoryAfter.rss,
  };
}

try {
  if (values["cpu-profile"]) {
    await workerProfiler?.start("cpu", path.join(values.profiles!, "cpu"));
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  for (const input of values["worker-entry"]
    ? []
    : [
        "\n<script>const =</script>",
        '<script type="module">await 1;</script>',
        "<script>return 1;</script>",
      ]) {
    assert.deepEqual(await candidate(input), await baseline(input));
  }
  console.log(
    JSON.stringify({
      kind: "metadata",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      baseline: path.resolve(values.baseline),
      candidate: path.resolve(values["worker-entry"] ?? values.candidate),
      packagedWorker: values["worker-entry"] && path.resolve(values["worker-entry"]),
      samples,
      calls,
      allocation: values.allocation,
      hostLoad: loadavg(),
      capturedAt: new Date().toISOString(),
      candidateSha256: createHash("sha256")
        .update(await readFile(values["worker-entry"] ?? values.candidate))
        .digest("hex"),
      units:
        "bytes are ASCII UTF-8; longestGapMs is the largest 1 ms timer interval, including scheduling noise",
      scope: `${values["worker-entry"] ? "raw parseWidgetScript versus packaged WorkerTaskPool (no memo/HTML scan)" : values.tool ? "show_widget.execute with synthetic presenter" : "syntax owner"}; CPU and sampled V8 heap allocation include workers (native backing stores excluded); no Gateway transport, session DB or workspace I/O`,
    }),
  );
  for (const bytes of values["worker-entry"]
    ? [100 * 1024]
    : [10 * 1024, 100 * 1024, 1024 * 1024]) {
    for (const [arm, check] of [
      ["A", baseline],
      ["B", candidate],
    ] as const) {
      console.log(
        JSON.stringify({
          kind: "cold",
          bytes,
          arm,
          ...(await measure(check, [widget(bytes, `cold-${arm}`)])),
        }),
      );
    }
    // Warm the parser/JIT and any retained worker before steady-state comparisons.
    for (let index = 0; index < 10; index++) {
      const input = widget(bytes, `warmup-${index}`);
      await baseline(input);
      await candidate(input);
    }
    const modes = values["worker-entry"]
      ? (["distinct", "repeat"] as const)
      : (["distinct", "repeat", "markup-only"] as const);
    for (const mode of modes) {
      const repeated = widget(bytes, `repeat-${mode}`);
      await baseline(repeated);
      await candidate(repeated);
      for (let sample = 0; sample < samples; sample++) {
        // A1/A2 are identical-code controls; each B observation is paired with its preceding A.
        for (const [arm, check] of [
          ["A1", baseline],
          ["B1", candidate],
          ["A2", baseline],
          ["B2", candidate],
        ] as const) {
          const inputs = Array.from({ length: calls }, (_, call) =>
            mode === "distinct"
              ? widget(bytes, `${sample}-${arm}-${call}`)
              : mode === "markup-only"
                ? `<p>Revision ${sample}-${arm}-${call}</p>\n${repeated}`
                : repeated,
          );
          console.log(
            JSON.stringify({
              kind: "sample",
              bytes,
              mode,
              sample,
              arm,
              ...(await measure(check, inputs)),
            }),
          );
        }
      }
    }
  }
  if (values["worker-entry"]) {
    assert.deepEqual(await candidate("const ="), await baseline("const ="));
  }
} finally {
  if (values["cpu-profile"]) {
    const { profile } = await inspector.post("Profiler.stop");
    await writeFile(path.join(values.profiles!, "main.cpuprofile"), JSON.stringify(profile), {
      mode: 0o600,
    });
    await workerProfiler?.stop("cpu");
  }
  inspector.disconnect();
  clearInterval(profilingKeepalive);
  await packagedPool?.close();
  process.off("worker", onWorker);
  await Promise.all([...workers].map((worker) => worker.terminate()));
}
