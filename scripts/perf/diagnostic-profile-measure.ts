// Frame normalization: --mode frames --nodes 4096 --iterations 5 (Node 26.12+).
// Each iteration sanitizes 20 batches; compare interleaved base/candidate runs.
// CPU and total allocated bytes are untraced; this is owner cost, not Gateway load.
import { createHook } from "node:async_hooks";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import path from "node:path";
import {
  constants,
  monitorEventLoopDelay,
  PerformanceObserver,
  type PerformanceEntry,
} from "node:perf_hooks";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { getHeapStatistics } from "node:v8";
import type { SamplingProfile } from "../../src/logging/diagnostic-heap-profile.js";

const args = process.argv.slice(2);
function option(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1]!;
}
const sourceRoot = path.resolve(option("source-root", "."));
const mode = option("mode", "all");
const iterations = Number(option("iterations", "5"));
const startAt = Number(option("start-at", "0"));
const output = option("output", "");
const nodes = Number(option("nodes", "65535"));
const samples = Number(option("samples", "131072"));
const allocationBytes = Number(option("allocation-bytes", String(4 * 1024 ** 3)));
if (
  !["all", "sanitize", "heap", "cpu", "record", "native-parse", "frames"].includes(mode) ||
  !Number.isSafeInteger(iterations) ||
  iterations < 1 ||
  !Number.isSafeInteger(nodes) ||
  nodes < 1 ||
  !Number.isSafeInteger(samples) ||
  samples < 1 ||
  !Number.isSafeInteger(allocationBytes) ||
  allocationBytes < 1
) {
  throw new Error("Invalid workload arguments");
}
const heap: typeof import("../../src/logging/diagnostic-heap-profile.js") = await import(
  pathToFileURL(path.join(sourceRoot, "src/logging/diagnostic-heap-profile.ts")).href
);
const cpu: typeof import("../../src/logging/diagnostic-cpu-profile.js") = await import(
  pathToFileURL(path.join(sourceRoot, "src/logging/diagnostic-cpu-profile.ts")).href
);
const flight: typeof import("../../src/logging/diagnostic-stall-flight-recorder.js") = await import(
  pathToFileURL(path.join(sourceRoot, "src/logging/diagnostic-stall-flight-recorder.ts")).href
);
const metadata = {
  durationMs: 30_000,
  requestedDurationMs: 600_000,
  effectiveDurationMs: 30_000,
  actualDurationMs: 30_000,
  durationLimitReason: "collected-samples" as const,
  samplingIntervalBytes: 32_768,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
  heapUsedBefore: 0,
  heapUsedAfter: 0,
  heapSpacesBefore: [],
  heapSpacesAfter: [],
  rssBefore: 0,
  rssAfter: 0,
};

function syntheticProfile(): SamplingProfile {
  const tree: SamplingProfile["head"][] = Array.from({ length: nodes }, (_, index) => ({
    id: index + 1,
    callFrame: {
      functionName: `allocation${index}`,
      scriptId: "1",
      url: `/synthetic/openclaw/src/module${index % 512}.ts`,
      lineNumber: index % 2000,
      columnNumber: index % 80,
    },
    children: [],
    selfSize: 0,
  }));
  for (let index = 1; index < nodes; index++) {
    tree[(index - 1) >> 1]!.children.push(tree[index]!);
  }
  return {
    head: tree[0]!,
    samples: Array.from({ length: samples }, (_, index) => {
      const size =
        Math.floor(allocationBytes / samples) + Number(index < allocationBytes % samples);
      tree[index % nodes]!.selfSize += size;
      return { nodeId: 1 + (index % nodes), size, ordinal: index + 1 };
    }),
  };
}

async function measure<T>(name: string, run: () => Promise<T> | T) {
  await delay(30);
  let callbackCount = 0;
  let maxCallbackMs = 0;
  const callbackStarts = new Map<number, number>();
  const hook = createHook({
    before(id) {
      callbackStarts.set(id, performance.now());
    },
    after(id) {
      const started = callbackStarts.get(id);
      if (started !== undefined) {
        maxCallbackMs = Math.max(maxCallbackMs, performance.now() - started);
        callbackCount++;
        callbackStarts.delete(id);
      }
    },
  });
  let gcCount = 0;
  let gcMs = 0;
  let majorGcCount = 0;
  let majorGcMs = 0;
  const recordGc = (entries: PerformanceEntry[]) => {
    for (const entry of entries) {
      const detail = (entry as PerformanceEntry & { detail: { kind: number } }).detail;
      gcCount++;
      gcMs += entry.duration;
      if (detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR) {
        majorGcCount++;
        majorGcMs += entry.duration;
      }
    }
  };
  const observer = new PerformanceObserver((list) => recordGc(list.getEntries()));
  const lag = monitorEventLoopDelay({ resolution: 1 });
  lag.enable();
  // The first histogram tick establishes its clock; prime it before synchronous work.
  await delay(10);
  observer.observe({ entryTypes: ["gc"] });
  const before = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const wallStart = performance.now();
  hook.enable();
  await immediate();
  const result = await run();
  const operationMs = performance.now() - wallStart;
  // Let the event-loop histogram and GC observer see the final synchronous callback.
  await delay(10);
  hook.disable();
  lag.disable();
  recordGc(observer.takeRecords());
  observer.disconnect();
  const usedCpu = process.cpuUsage(cpuBefore);
  const after = process.memoryUsage();
  return {
    metrics: {
      name,
      operationMs,
      cpuMs: (usedCpu.user + usedCpu.system) / 1000,
      maxCallbackMs,
      callbackCount,
      maxEventLoopDelayMs: lag.max / 1e6,
      eventLoopDelaySampleCount: lag.count,
      gcMs,
      gcCount,
      majorGcMs,
      majorGcCount,
      majorGcIsContextOnly: majorGcCount < 50,
      heapDeltaBytes: after.heapUsed - before.heapUsed,
      // A main-thread timer misses synchronous peaks. This is the OS process high-water mark.
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    },
    result,
  };
}

async function allocateForCapture(durationMs: number, bytes: number) {
  const startedAt = performance.now();
  const live: number[][] = [];
  let allocatedBytes = 0;
  let sequence = 0;
  while (allocatedBytes < bytes) {
    const target = Math.min(bytes, ((performance.now() - startedAt) / durationMs) * bytes);
    // At most 2 MiB per turn; the workload itself must not manufacture the stall.
    const stopAt = Math.min(target, allocatedBytes + 2 * 1024 ** 2);
    while (allocatedBytes < stopAt) {
      const array = Array.from({ length: 16_384 }, (_, index) => index + sequence + 0.125);
      live[sequence++ % 8] = array;
      allocatedBytes += array.length * 8;
    }
    await delay(5);
  }
  return { allocatedPayloadBytes: allocatedBytes, retainedPayloadBytes: live.length * 16_384 * 8 };
}

const reports: unknown[] = [];
if (startAt) {
  const waitMs = startAt - Date.now();
  if (waitMs < 0) {
    throw new Error("Missed --start-at; do not compare unsynchronized pairs");
  }
  await delay(waitMs);
}
if (mode === "frames") {
  const {
    sanitizeDiagnosticProfileFrame,
  }: typeof import("../../src/logging/diagnostic-profile.js") = await import(
    pathToFileURL(path.join(sourceRoot, "src/logging/diagnostic-profile.ts")).href
  );
  const frames = Array.from({ length: nodes }, (_, index) => ({
    functionName: `work${index}`,
    scriptId: String(index),
    lineNumber: index,
    columnNumber: 0,
    url: path.join(
      "/fixture",
      index % 3 === 0 ? "openclaw/src" : index % 3 === 1 ? "openclaw/dist" : "node_modules/ws/lib",
      `module${index % 512}.js`,
    ),
  }));
  const packageRoot = path.resolve("/fixture/openclaw");
  const batch = () => {
    for (const frame of frames) {
      sanitizeDiagnosticProfileFrame(frame, packageRoot);
    }
  };
  for (let warm = 0; warm < 5; warm++) {
    batch();
  }
  for (let iteration = 0; iteration < iterations; iteration++) {
    const allocated = getHeapStatistics().total_allocated_bytes;
    const cpuBefore = process.threadCpuUsage();
    const startedAt = performance.now();
    for (let pass = 0; pass < 20; pass++) {
      batch();
    }
    const wallMs = performance.now() - startedAt;
    const usedCpu = process.threadCpuUsage(cpuBefore);
    reports.push({
      iteration,
      frames: nodes * 20,
      cpuMs: (usedCpu.user + usedCpu.system) / 1000,
      wallMs,
      allocatedBytes: getHeapStatistics().total_allocated_bytes - allocated,
    });
  }
}
if (mode === "native-parse") {
  const { parseNativeCpuProfile }: typeof import("../../src/logging/diagnostic-profile.js") =
    await import(pathToFileURL(path.join(sourceRoot, "src/logging/diagnostic-profile.ts")).href);
  const nativeNodes = Array.from(
    { length: nodes },
    (_, index) =>
      `{"id":${index + 1},"hitCount":${index % 3},"callFrame":{"functionName":"work${index}","lineNumber":${index - 2},"columnNumber":-1,"scriptId":${index - 2},"url":"file:///fixture/module${index % 512}.js"}${index + 1 < nodes ? `,"children":[${index + 2}]` : ""}${index % 2 === 0 ? ',"deoptReason":"not optimized","positionTicks":[{"line":1,"ticks":2}]' : ""}}`,
  );
  const json = `{"nodes":[${nativeNodes.join(",")}],"startTime":10000,"endTime":5510000,"samples":${JSON.stringify(Array.from({ length: samples }, (_, index) => 1 + (index % nodes)))},"timeDeltas":${JSON.stringify(Array(samples).fill(1000))}}`;
  const parses = 20;
  for (let index = 0; index < 5; index++) {
    parseNativeCpuProfile(json);
  }
  const session = new Session();
  session.connect();
  try {
    for (let iteration = 0; iteration < iterations; iteration++) {
      await session.post("HeapProfiler.startSampling", {
        samplingInterval: 16_384,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      for (let index = 0; index < parses; index++) {
        parseNativeCpuProfile(json);
      }
      const { profile } = await session.post("HeapProfiler.stopSampling");
      let sampledBytes = 0;
      const visit = (node: typeof profile.head, owned = false) => {
        const inOwner = owned || node.callFrame.functionName === "parseNativeCpuProfile";
        if (inOwner) {
          sampledBytes += node.selfSize;
        }
        for (const child of node.children) {
          visit(child, inOwner);
        }
      };
      visit(profile.head);
      reports.push({
        iteration,
        parses,
        nodeCount: nodes,
        inputBytes: Buffer.byteLength(json),
        allocationSamples: profile.samples.length,
        sampledBytesPerParse: sampledBytes / parses,
      });
    }
  } finally {
    session.disconnect();
  }
}
if (mode === "all" || mode === "sanitize") {
  const profile = syntheticProfile();
  for (let index = 0; index < iterations; index++) {
    const { metrics, result: json } = await measure("heap-sanitize", async () =>
      JSON.stringify(
        await heap.sanitizeDiagnosticHeapProfile(profile, "/synthetic/openclaw", metadata),
      ),
    );
    reports.push({
      ...metrics,
      iteration: index,
      nodeCount: nodes,
      allocationSampleCount: samples,
      sampledBytes: allocationBytes,
      outputBytes: Buffer.byteLength(json),
      outputSha256: createHash("sha256").update(json).digest("hex"),
    });
  }
}
if (mode === "all" || mode === "heap") {
  let nativeProfile: SamplingProfile | undefined;
  let inspectorStopMs = 0;
  // oxlint-disable-next-line typescript/unbound-method -- Restored below; calls use Reflect.apply with the live session.
  const originalPost = Session.prototype.post;
  // Forward inspector overloads unchanged; retain its result only for workload counts.
  Session.prototype.post = function (this: Session, method: string, ...params: unknown[]) {
    const started = performance.now();
    const result: Promise<unknown> = Reflect.apply(originalPost, this, [method, ...params]);
    return result.then((value) => {
      if (method === "HeapProfiler.stopSampling") {
        inspectorStopMs = performance.now() - started;
        nativeProfile = (value as { profile: SamplingProfile }).profile;
      }
      return value;
    });
  } as Session["post"];
  const { metrics, result } = await measure("heap-capture", async () => {
    const capture = heap.captureDiagnosticHeapProfile({
      durationMs: 600_000,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
      samplingIntervalBytes: 32_768,
      signal: new AbortController().signal,
      hasAuthority: () => true,
    });
    const allocated = await allocateForCapture(28_000, allocationBytes);
    const completed = await capture;
    return {
      capture: completed,
      allocated,
      responseBytes: Buffer.byteLength(JSON.stringify(completed)),
    };
  });
  Session.prototype.post = originalPost;
  if (result.capture.status !== "complete") {
    throw new Error(`Heap capture unavailable: ${result.capture.reason}`);
  }
  if (!nativeProfile) {
    throw new Error("Missing native heap profile workload counts");
  }
  const nativeNodes = [nativeProfile.head];
  for (const node of nativeNodes) {
    nativeNodes.push(...node.children);
  }
  const {
    profile: _profile,
    summary: _summary,
    ...captureMetadata
  } = result.capture.result as typeof result.capture.result & {
    profile?: unknown;
    summary?: unknown;
  };
  reports.push({
    ...metrics,
    ...result.allocated,
    nativeNodeCount: nativeNodes.length,
    nativeSampleCount: nativeProfile.samples.length,
    nativeSampledBytes: nativeProfile.samples.reduce((sum, sample) => sum + sample.size, 0),
    inspectorStopMs,
    responseBytes: result.responseBytes,
    captureMetadata,
  });
}
if (mode === "all" || mode === "cpu") {
  const warnings: string[] = [];
  // Production keeps this overlapping recorder alive, avoiding a cold native heap scan.
  const recorder = flight.createStallFlightRecorder((warning) => warnings.push(warning));
  const recorderTimer = setInterval(() => recorder.sample(), 1000);
  try {
    const { metrics, result } = await measure("cpu-capture-shared-recorder", async () => {
      const capture = cpu.captureDiagnosticCpuProfile({
        signal: new AbortController().signal,
        hasAuthority: () => true,
      });
      const allocated = await allocateForCapture(4000, 128 * 1024 ** 2);
      const completed = await capture;
      return {
        capture: completed,
        allocated,
        responseBytes: Buffer.byteLength(JSON.stringify(completed)),
      };
    });
    if (result.capture.status !== "complete") {
      throw new Error(`CPU capture unavailable: ${result.capture.reason}`);
    }
    reports.push({
      ...metrics,
      ...result.allocated,
      requestedDurationMs: result.capture.result.requestedDurationMs,
      actualDurationMs: result.capture.result.actualDurationMs,
      startBlockedMs: result.capture.result.startBlockedMs,
      nativeSampleCount:
        result.capture.result.profile?.samples?.length ??
        ("sampleCount" in result.capture.result ? result.capture.result.sampleCount : 0),
      responseBytes: result.responseBytes,
      warnings,
    });
  } finally {
    clearInterval(recorderTimer);
    recorder.stop();
  }
}
if (mode === "record") {
  const session = new Session();
  session.connect();
  try {
    await session.post("HeapProfiler.enable");
    await session.post("HeapProfiler.startSampling", { samplingInterval: 4096 });
    const live = Array.from({ length: 4 }, (_, index) => Array(4096).fill(index + 0.125));
    const { profile } = await session.post("HeapProfiler.stopSampling");
    const recorded = profile as SamplingProfile;
    const pending = [recorded.head];
    for (const node of pending) {
      node.callFrame.url = node.callFrame.url
        .replaceAll(sourceRoot, "/fixture/openclaw")
        .replaceAll(path.dirname(sourceRoot), "/fixture/openclaw");
      pending.push(...node.children);
    }
    const packageRoot = "/fixture/openclaw";
    const sanitized = await heap.sanitizeDiagnosticHeapProfile(recorded, packageRoot, metadata);
    reports.push({
      raw: recorded,
      packageRoot,
      metadata,
      sanitized,
      retained: live.length,
    });
    await session.post("HeapProfiler.disable");
  } finally {
    session.disconnect();
  }
}
const json = JSON.stringify({ runtime: process.version, sourceRoot, mode, reports }, null, 2);
if (output) {
  await writeFile(output, `${json}\n`);
}
console.log(json);
