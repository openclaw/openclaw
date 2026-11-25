import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { PromptHistoryFingerprint } from "../../src/agents/embedded-agent-runner/prompt-cache-history.js";
import type {
  PromptPreparationResult,
  PromptPreparationTask,
} from "../../src/agents/embedded-agent-runner/provider-prompt-state.js";
import type { GcSample } from "../../src/infra/gc-observer.js";
import {
  sampleTrackedWorkerMemory,
  setTrackedWorkerGcObserver,
} from "../../src/infra/worker-cpu.js";
import { WorkerTaskPool } from "../../src/infra/worker-task-pool.js";
const { values } = parseArgs({
  options: { "start-at": { type: "string", default: "0" }, output: { type: "string" } },
});
const startAt = Number(values["start-at"]);
assert.ok(Number.isSafeInteger(startAt) && startAt >= 0, "--start-at must be epoch milliseconds");
const clients = 4,
  bursts = 4,
  tasksPerBurst = 5000,
  warmupPerBurst = 500;
const pool = new WorkerTaskPool<PromptPreparationTask, PromptPreparationResult>({
  workerUrl: new URL(
    "../../src/agents/embedded-agent-runner/provider-prompt-state.worker.ts",
    import.meta.url,
  ),
  workerClass: "compute",
  sharedCompute: true,
});
let observedGc: {
  count: number;
  durationMs: number;
  byKind: Partial<Record<GcSample["kind"], { count: number; durationMs: number }>>;
} = { count: 0, durationMs: 0, byKind: {} };
setTrackedWorkerGcObserver((samples, thread) => {
  if (thread !== "provider-prompt-state.worker.js") {
    return;
  }
  for (const sample of samples) {
    const kind = (observedGc.byKind[sample.kind] ??= { count: 0, durationMs: 0 });
    kind.count++;
    kind.durationMs += sample.durationMs;
    observedGc.count++;
    observedGc.durationMs += sample.durationMs;
  }
});

function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const quantile = (fraction: number) => ({
    samples: sorted.length,
    ms: sorted[Math.ceil(sorted.length * fraction) - 1],
  });
  return {
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: quantile(0.5),
    p95: quantile(0.95),
    p99: quantile(0.99),
  };
}

function processCpuMs() {
  const { userCPUTime, systemCPUTime } = process.resourceUsage();
  return (userCPUTime + systemCPUTime) / 1000;
}
const rows = [];
const invocationCpu = processCpuMs();
try {
  for (const [phase, messages, textBytes] of [
    ["cheap", 1, 32],
    ["history-256kib", 64, 4096],
  ] as const) {
    const history = Array.from({ length: messages }, (_, index) => ({
      role: "user" as const,
      content: `Synthetic message ${index}: `.padEnd(textBytes, "x"),
      timestamp: index,
    }));
    const textDigests = history.map((message) => `t${hash("sha256", message.content, "latin1")}`);
    let expected: PromptHistoryFingerprint[] | undefined;
    let errors = 0;
    let firstError: string | undefined;
    const latency: number[] = [];
    const rotations: number[] = [];
    let cpuMs = 0;
    let elapsedMs = 0;
    observedGc = { count: 0, durationMs: 0, byKind: {} };
    const run = async (tasks: number, timings?: number[]) => {
      let next = 0;
      await Promise.all(
        Array.from({ length: clients }, async () => {
          while (next++ < tasks) {
            const started = performance.now();
            try {
              const result = await pool.run(
                { history },
                { inputBytes: messages * (textBytes * 2 + 128) },
              );
              timings?.push(performance.now() - started);
              assert.ok(result.kind === "history", "Unexpected provider result");
              assert.equal(result.fingerprints.length, messages);
              for (const [index, fingerprint] of result.fingerprints.entries()) {
                assert.ok(
                  fingerprint.role === "user" &&
                    fingerprint.identityLength === 66 &&
                    fingerprint.packed.slice(33, 66) === textDigests[index] &&
                    (!expected || fingerprint.packed === expected[index]?.packed),
                  "Fingerprint mismatch",
                );
              }
              expected ??= result.fingerprints;
            } catch (error) {
              errors++;
              firstError ??= String(error);
            }
          }
        }),
      );
    };
    for (let burst = 0; burst < bursts; burst++) {
      const beforeWarmupErrors = errors;
      await run(warmupPerBurst);
      assert.equal(errors, beforeWarmupErrors, `Warmup failed: ${firstError}`);
      if (rows.length === 0 && burst === 0 && startAt) {
        assert.ok(Date.now() < startAt, "Missed --start-at after setup and warmup");
        await delay(startAt - Date.now());
      }
      const cpu = processCpuMs();
      const started = performance.now();
      await run(tasksPerBurst, latency);
      elapsedMs += performance.now() - started;
      cpuMs += processCpuMs() - cpu;
      const retiring = performance.now();
      await pool.rotate();
      rotations.push(performance.now() - retiring);
    }
    rows.push({
      phase,
      clients,
      measuredTasks: bursts * tasksPerBurst,
      warmupTasks: bursts * warmupPerBurst,
      messagesPerTask: messages,
      textBytesPerTask: messages * textBytes,
      errors,
      firstError,
      latency: distribution(latency),
      elapsedMs,
      cpuMs,
      rotationMs: rotations,
      fingerprintDigest: hash("sha256", JSON.stringify(expected), "hex"),
      gcIncludingWarmupAndRetirement: observedGc,
      retainedAfter: sampleTrackedWorkerMemory().workerTaskMetrics,
    });
    if (errors || latency.length !== bursts * tasksPerBurst) {
      process.exitCode = 1;
    }
  }
} finally {
  await pool.close();
  setTrackedWorkerGcObserver(undefined);
}
const output = JSON.stringify(
  {
    node: process.version,
    startAt,
    rows,
    totalProcessCpuMs: processCpuMs() - invocationCpu,
    retainedAfterClose: sampleTrackedWorkerMemory().workerTaskMetrics,
  },
  null,
  2,
);
if (values.output) {
  await writeFile(values.output, `${output}\n`);
}
console.log(output);
