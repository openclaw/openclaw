/**
 * Real quiet child through the exec owner; compare the frozen polling wait with
 * the registry's event wait. No Gateway, database, or operator state is loaded.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/process-poll-wait-measure.ts
 * Repeat with --sample for collected-object allocation; timing remains untraced.
 * Five counterbalanced A/A/B samples, each a real minute of a running command.
 * Acceptance: identical completed output/status, fewer timer allocations and
 * sampled bytes, no regression in CPU or completion-observation latency.
 */
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  deleteSession,
  markBackgrounded,
  prepareSessionPoll,
  type ProcessSession,
  waitForSessionPoll,
} from "../../src/agents/bash-process-registry.js";
import { runExecProcess } from "../../src/agents/bash-tools.exec-runtime.js";
import { sleep } from "../../src/utils/sleep.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    "duration-ms": { type: "string" },
    samples: { type: "string" },
    sample: { type: "boolean", default: false },
    counts: { type: "boolean", default: false },
  },
});
const durationMs = parseStrictIntegerOption({
  raw: values["duration-ms"],
  fallback: 60_000,
  min: 1,
  label: "duration-ms",
});
const samples = parseStrictIntegerOption({
  raw: values.samples,
  fallback: 5,
  min: 1,
  label: "samples",
});
assert(globalThis.gc, "Run with --expose-gc");

// Frozen pre-change wait; preserve its per-tick catch and abort subscription.
function sleepPollInterval(ms: number, signal: AbortSignal): Promise<void> {
  return sleep(ms, signal).catch((error: unknown) => {
    throw signal.aborted ? signal.reason : error;
  });
}
async function baseline(session: ProcessSession, timeoutMs: number, signal: AbortSignal) {
  const deadline = performance.now() + timeoutMs;
  while (
    !session.exited &&
    !session.pendingPollDelivery &&
    session.pendingStdoutChars + session.pendingStderrChars === 0 &&
    !session.pendingOutputDropped &&
    performance.now() < deadline
  ) {
    await sleepPollInterval(Math.max(0, Math.min(250, deadline - performance.now())), signal);
  }
}
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}
const arms = [
  { name: "base-a", wait: baseline },
  { name: "base-b", wait: baseline },
  { name: "candidate", wait: waitForSessionPoll },
];
const scratchRoot = path.join(process.cwd(), ".cache");
await mkdir(scratchRoot, { recursive: true });
const workspace = await mkdtemp(path.join(scratchRoot, "process-poll-wait-"));
const inspector = values.sample ? new Session() : undefined;
inspector?.connect();
try {
  for (let sample = -1; sample < samples; sample++) {
    const warmup = sample < 0;
    for (const arm of sample % 2 ? arms.toReversed() : arms) {
      let exitObservedAt = 0;
      const run = await runExecProcess({
        command: "synthetic quiet command",
        workdir: workspace,
        env: {},
        sandbox: {
          containerName: "process-poll-measure-fixture",
          workspaceDir: workspace,
          containerWorkdir: workspace,
          async buildExecSpec() {
            return {
              argv: [process.execPath, "-e", `setTimeout(() => {}, ${warmup ? 100 : durationMs})`],
              env: {},
              stdinMode: "pipe-closed",
            };
          },
        },
        usePty: false,
        warnings: [],
        maxOutput: 1000,
        pendingMaxOutput: 1000,
        notifyOnExit: false,
        timeoutSec: 0,
        onSettledBeforeNotify() {
          exitObservedAt = performance.now();
        },
      });
      markBackgrounded(run.session);
      const signal = new AbortController().signal;
      let timers = 0;
      let promises = 0;
      let polls = 0;
      const hook = values.counts
        ? createHook({
            init(_id, type) {
              if (type === "Timeout") {
                timers++;
              }
              if (type === "PROMISE") {
                promises++;
              }
            },
          })
        : undefined;
      try {
        globalThis.gc();
        const hostLoadBefore = loadavg();
        if (inspector && !warmup) {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 1024,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        hook?.enable();
        const cpuBefore = process.cpuUsage();
        const start = performance.now();
        while (!run.session.exited) {
          polls++;
          await arm.wait(run.session, 30_000, signal);
          assert.equal(prepareSessionPoll(run.session, undefined).output, "");
        }
        const observedAt = performance.now();
        const cpu = process.cpuUsage(cpuBefore);
        hook?.disable();
        const allocationBytes =
          inspector && !warmup
            ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
            : undefined;
        const outcome = await run.promise;
        assert.equal(outcome.status, "completed");
        assert.equal(run.session.exitCode, 0);
        if (!warmup) {
          console.log(
            JSON.stringify({
              mode: values.sample ? "allocation" : values.counts ? "work-count" : "timing",
              sample,
              arm: arm.name,
              requestedDurationMs: durationMs,
              wallMs: observedAt - start,
              cpuMs: (cpu.user + cpu.system) / 1000,
              allocationBytes,
              bytesPerMinute:
                allocationBytes === undefined ? undefined : (allocationBytes * 60_000) / durationMs,
              polls,
              timers: values.counts ? timers : undefined,
              promises: values.counts ? promises : undefined,
              observationLagMs: Math.max(0, observedAt - exitObservedAt),
              hostLoadBefore,
              hostLoadAfter: loadavg(),
            }),
          );
        }
      } finally {
        hook?.disable();
        if (!run.session.exited) {
          run.kill();
        }
        await run.promise;
        deleteSession(run.session.id);
      }
    }
  }
} finally {
  inspector?.disconnect();
  await rm(workspace, { recursive: true, force: true });
}
