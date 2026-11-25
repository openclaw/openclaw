/**
 * Tokenjuice owner CPU/allocation, with synthetic outputs and no stats writes:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tokenjuice-tool-result-measure.ts --module extensions/tokenjuice/tool-result-middleware.ts --mode timing --iterations 2000
 * Repeat with --mode allocation (collected objects included); alternate revisions
 * in separate processes, five times each. --module can name an unchanged source
 * snapshot with its runtime-api.ts sibling. Compare outputSha256 before costs.
 * The real-cwd churn case uses 160 results to include a full 128-scope eviction;
 * all other cases use --iterations. Warmup is 40 results per case.
 * Output hashes cover every prepared event after measurement. The 64 KiB
 * sampling interval bounds profiler overhead. Timing and allocation are separate
 * passes; setup, hashing, and GC are outside measurement.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AgentToolResultMiddlewareEvent } from "../../src/plugin-sdk/agent-harness.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    module: { type: "string", default: "extensions/tokenjuice/tool-result-middleware.ts" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "2000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(values.mode === "timing" || values.mode === "allocation");
process.env.TOKENJUICE_STATS = "0";
process.env.TOKENJUICE_NO_OMISSION = "1";
const {
  createTokenjuiceAgentToolResultMiddleware: createMiddleware,
}: typeof import("../../extensions/tokenjuice/tool-result-middleware.js") = await import(
  pathToFileURL(path.resolve(values.module)).href
);
const root = path.resolve(".local/buf664/synthetic");
const small = "On branch main\n\nChanges not staged for commit:\n\tmodified:   src/a.ts\n";
const large = `${small}${Array.from({ length: 200 }, (_, i) => `\tmodified:   src/component-${i}.ts`).join("\n")}\n`;
const workloads = [
  { name: "small", command: "git status", text: small },
  { name: "small-no-status", command: "git status", text: small },
  { name: "large", command: "git status", text: large },
  { name: "non-matching", command: "custom-build --verbose", text: large },
  { name: "file-read", command: "cat README.md", text: large },
  { name: "non-exec-churn", command: "git status", text: small },
  { name: "shadowed-cwd-churn", command: "git status", text: small },
  { name: "real-cwd-churn", command: "git status", text: small },
];
for (const workload of workloads) {
  const middleware = createMiddleware();
  const count = workload.name === "real-cwd-churn" ? 160 : iterations;
  const events: AgentToolResultMiddlewareEvent[] = Array.from({ length: 160 }, (_, i) => ({
    toolCallId: "synthetic",
    toolName: workload.name === "non-exec-churn" ? "read" : "exec",
    args: {
      command: workload.command,
      workdir: workload.name === "real-cwd-churn" ? `${root}/project-${i}` : root,
    },
    cwd: workload.name.endsWith("churn") ? `${root}/session-${i}` : root,
    result: {
      content: [{ type: "text", text: workload.text }],
      details:
        workload.name === "small-no-status"
          ? { exitCode: 0, cwd: root }
          : { status: "completed", exitCode: 0, cwd: root },
    },
  }));
  let last: unknown;
  const run = async (i: number) => {
    const event = events[i % events.length]!;
    const response = await middleware(event, { runtime: "openclaw" });
    last = response?.result ?? event.result;
  };
  for (let i = 0; i < 40; i++) {
    await run(i);
  }
  global.gc?.();
  const inspector = new Session();
  if (values.mode === "allocation") {
    await startCollectedHeapSampling(inspector, 65536);
  }
  const loadBefore = loadavg();
  const cpuStart = process.cpuUsage();
  const threadStart = process.threadCpuUsage();
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    await run(i);
  }
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  const thread = process.threadCpuUsage(threadStart);
  let allocatedBytes: number | undefined;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocatedBytes = sumSampledHeapBytes(profile.head);
    inspector.disconnect();
  }
  const memory = process.memoryUsage();
  const outputHash = createHash("sha256");
  for (let i = 0; i < events.length; i++) {
    await run(i);
    outputHash.update(JSON.stringify(last));
  }
  console.log(
    JSON.stringify({
      module: values.module,
      mode: values.mode,
      workload: workload.name,
      iterations: count,
      inputChars: workload.text.length,
      wallMs,
      cpuMs: values.mode === "timing" ? (cpu.user + cpu.system) / 1000 : undefined,
      mainThreadCpuMs: values.mode === "timing" ? (thread.user + thread.system) / 1000 : undefined,
      bytesPerResult: allocatedBytes === undefined ? undefined : allocatedBytes / count,
      outputSha256: outputHash.digest("hex"),
      loadBefore,
      loadAfter: loadavg(),
      memory,
    }),
  );
}
