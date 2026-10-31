/**
 * Compare background-output queue preparation across two source revisions:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/process-change-queue-measure.ts \
 *   --base-owner /absolute/path/to/base/bash-process-registry.ts
 * --candidate-owner can select a separately prepared candidate module.
 * Add --allocations for a separate collected-object allocation pass. Do not use
 * allocation-pass CPU timings. Five counterbalanced samples, 21 running scopes,
 * 200,000 interleaved output chunks per arm; output retention is bounded at 2 KiB.
 * Acceptance: less allocation/CPU with identical coalesced notifications, output,
 * and terminal observations (covered by the registry regression and Gateway run).
 * This measures the real append owner, not WebSocket fanout or whole-Gateway load.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import * as candidate from "../../src/agents/bash-process-registry.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "base-owner": { type: "string" },
    "candidate-owner": { type: "string" },
    iterations: { type: "string", default: "200000" },
    allocations: { type: "boolean", default: false },
  },
});
assert(values["base-owner"], "--base-owner is required");
assert(globalThis.gc, "Run with --expose-gc");
const base = (await import(pathToFileURL(resolve(values["base-owner"])).href)) as typeof candidate;
const candidateRegistry = values["candidate-owner"]
  ? ((await import(pathToFileURL(resolve(values["candidate-owner"])).href)) as typeof candidate)
  : candidate;
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 200_000,
  min: 1,
  label: "iterations",
});
const arms = [
  { name: "base", registry: base },
  { name: "candidate", registry: candidateRegistry },
];
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
}
try {
  for (let sample = -1; sample < 5; sample++) {
    for (const { name, registry } of sample % 2 ? arms.toReversed() : arms) {
      const sessions = Array.from({ length: 21 }, (_, index) => {
        const session = registry.createProcessSession({
          id: `process-${index}`,
          command: "synthetic output writer",
          scopeKey: `agent:main:synthetic-session-${index}`,
          agentId: "main",
          cleanupMs: 60_000,
          startedAt: 1,
          maxOutputChars: 2048,
          pendingMaxOutputChars: 2048,
          totalOutputChars: 0,
          pendingStdoutChars: 0,
          pendingStderrChars: 0,
          pendingOutputDropped: false,
          exited: false,
          truncated: false,
          backgrounded: true,
          cursorKeyMode: "unknown",
        });
        registry.addSession(session);
        return session;
      });
      const unsubscribe = registry.onBackgroundProcessesChanged(() => {});
      try {
        globalThis.gc();
        const hostLoadBefore = loadavg();
        if (values.allocations && sample >= 0) {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 1024,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const cpuBefore = process.threadCpuUsage();
        const started = performance.now();
        const count = sample < 0 ? 10_000 : iterations;
        for (let index = 0; index < count; index++) {
          registry.appendOutput(sessions[index % sessions.length]!, "stdout", "output\n");
        }
        const wallMs = performance.now() - started;
        const cpu = process.threadCpuUsage(cpuBefore);
        const allocationBytes =
          values.allocations && sample >= 0
            ? allocated((await inspector.post("HeapProfiler.stopSampling")).profile.head)
            : undefined;
        if (sample >= 0) {
          console.log(
            JSON.stringify({
              arm: name,
              sample,
              iterations: count,
              mode: values.allocations ? "allocation" : "timing",
              wallMs,
              mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
              allocationBytes,
              bytesPerChunk: allocationBytes === undefined ? undefined : allocationBytes / count,
              hostLoadBefore,
              hostLoadAfter: loadavg(),
              memory: process.memoryUsage(),
            }),
          );
        }
      } finally {
        unsubscribe();
        for (const session of sessions) {
          session.backgrounded = false;
          registry.markExited(session, 0, null, "completed");
        }
      }
    }
  }
} finally {
  inspector.disconnect();
}
