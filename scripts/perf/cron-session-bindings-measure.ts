/**
 * Cron binding owner benchmark: 1,000 jobs, 200 session-scoped scans, with the
 * matching jobs rechecked before publication. Two routing contexts interleave;
 * each tenth scan edits/rebinds one job. This measures owner work, not RPC latency.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/cron-session-bindings-measure.ts \
 *   --owner /path/to/built-owner.mjs --mode timing --output .local/bindings.json
 * Run five counterbalanced base/candidate pairs, separately for timing and
 * allocation. Allocation sampling includes collected objects. Accept unchanged
 * match counts and lower CPU/allocation; report cold preparation and retention.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { CronStoredJob } from "../../src/cron/types.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    mode: { type: "string", default: "timing" },
    output: { type: "string" },
  },
});
assert(values.owner && values.output, "--owner and --output required");
assert(values.mode === "timing" || values.mode === "allocation");
assert(global.gc, "--expose-gc required");
const { resolveCronJobBoundSessionKeys }: typeof import("../../src/cron/job-session-bindings.js") =
  await import(pathToFileURL(values.owner).href);
const contexts: { cfg: OpenClawConfig; defaultAgentId: string }[] = [
  { cfg: { session: { mainKey: "home" } }, defaultAgentId: "ops" },
  { cfg: { session: { mainKey: "inbox" } }, defaultAgentId: "research" },
];
const jobs: CronStoredJob[] = Array.from({ length: 1000 }, (_, index) => ({
  id: `synthetic-${index}`,
  name: `Synthetic job ${index}`,
  agentId: index % 3 === 0 ? "ops" : undefined,
  sessionKey: index % 5 === 0 ? "shared" : `delivery-${index}`,
  sourceConversation: { sessionKey: `source-${index}`, sessionId: `creator-${index}` },
  sessionTarget: index % 4 === 0 ? "main" : "isolated",
  enabled: true,
  createdAtMs: 1_800_000_000_000,
  updatedAtMs: 1_800_000_000_000,
  schedule: { kind: "every", everyMs: 60_000 },
  wakeMode: "next-heartbeat",
  payload: { kind: "agentTurn", message: "synthetic" },
  state: {},
}));
const read = (index: number) => {
  const opts = contexts[index % contexts.length]!;
  let matches = 0;
  for (const job of jobs) {
    if (resolveCronJobBoundSessionKeys(job, opts).has("agent:ops:shared")) {
      assert(resolveCronJobBoundSessionKeys(job, opts).has("agent:ops:shared"));
      matches++;
    }
  }
  return matches;
};
global.gc();
const heapBeforePreparation = process.memoryUsage().heapUsed;
const coldCpu = process.cpuUsage();
for (let i = 0; i < 2; i++) {
  read(i);
}
const preparationCpu = process.cpuUsage(coldCpu);
global.gc();
const retainedPreparationBytes = process.memoryUsage().heapUsed - heapBeforePreparation;
for (let i = 0; i < 20; i++) {
  read(i);
}
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
let gcMs = 0;
let gcCount = 0;
let gcMaxMs = 0;
let start = Infinity;
let end = Infinity;
const observer = new PerformanceObserver((entries) => {
  for (const entry of entries.getEntries()) {
    if (entry.startTime >= start && entry.startTime < end) {
      gcMs += entry.duration;
      gcCount++;
      gcMaxMs = Math.max(gcMaxMs, entry.duration);
    }
  }
});
observer.observe({ entryTypes: ["gc"] });
const hostLoad = loadavg();
const cpuStart = process.cpuUsage();
start = performance.now();
let matches = 0;
for (let scan = 0; scan < 200; scan++) {
  if (scan % 10 === 0) {
    const job = jobs[scan]!;
    job.agentId = "rebound";
    job.sessionKey = "edited";
  }
  matches += read(scan);
}
end = performance.now();
const cpu = process.cpuUsage(cpuStart);
const memory = process.memoryUsage();
await nextTurn();
await nextTurn();
observer.disconnect();
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
let sampledBytes: number | undefined;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledBytes = allocated(profile.head);
  inspector.disconnect();
}
await writeFile(
  values.output,
  JSON.stringify(
    {
      mode: values.mode,
      ownerSha256: createHash("sha256")
        .update(await readFile(values.owner))
        .digest("hex"),
      scans: 200,
      jobs: jobs.length,
      matches,
      wallMs: end - start,
      cpuMs: (cpu.user + cpu.system) / 1000,
      preparationCpuMs: (preparationCpu.user + preparationCpu.system) / 1000,
      retainedPreparationBytes,
      sampledBytes,
      gcMs,
      gcCount,
      gcMaxMs,
      memory,
      hostLoad,
      hostLoadAfter: loadavg(),
    },
    null,
    2,
  ) + "\n",
);
