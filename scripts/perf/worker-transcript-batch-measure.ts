// Owner microbenchmark: transcript batching with synthetic text/tool-result turns.
// Bundle each revision's src/worker/worker-rpc-transcript-client.ts using esbuild:
// --bundle --packages=external --format=esm --platform=node --outfile=<revision>.mjs
// node --import ./scripts/tsx.mjs scripts/perf/worker-transcript-batch-measure.ts \
//   <base.mjs> <candidate.mjs> [timing|allocation] [iterations=1000]
// Run AB then BA. Allocation sampling includes collected objects; timing is untraced.
// Acceptance: identical messages/batch counts, reduced allocation, no material CPU
// regression. This measures the owner with synthetic RPC acknowledgements, not a Gateway.
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import os from "node:os";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { WorkerTranscriptMessage } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerConnection } from "../../src/worker/worker-connection.js";
import type { WorkerTranscriptCommitClient } from "../../src/worker/worker-rpc-transcript-client.js";

const [base, candidate, mode = "timing", count = "1000"] = process.argv.slice(2);
assert(base && candidate && (mode === "timing" || mode === "allocation"));
const iterations = Number(count);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const messages: WorkerTranscriptMessage[] = Array.from({ length: 64 }, (_, index) =>
  index % 2 === 0
    ? {
        role: "user",
        content: [{ type: "text", text: "synthetic prompt ".repeat(8) }],
        timestamp: index,
      }
    : {
        role: "toolResult",
        toolCallId: `tool-${index}`,
        toolName: "read",
        content: [{ type: "text", text: "synthetic file content ".repeat(8) }],
        isError: false,
        timestamp: index,
      },
);

function allocatedBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocatedBytes(child), 0);
}

for (const [arm, file] of [
  ["base", base],
  ["candidate", candidate],
] as const) {
  const { WorkerTranscriptCommitClient: Client } = (await import(pathToFileURL(file).href)) as {
    WorkerTranscriptCommitClient: typeof WorkerTranscriptCommitClient;
  };
  let calls = 0;
  let received = 0;
  // The only replaced boundary is the remote acknowledgement; batching and byte
  // admission execute unchanged from the selected revision.
  const connection = {
    waitForReady: async () => {},
    rpc: {
      request: async (_kind: string, request: { messages: WorkerTranscriptMessage[] }) => {
        calls++;
        received += request.messages.length;
        assert.equal(request.messages.length, 64);
        assert.equal(request.messages[0], messages[0]);
        assert.equal(request.messages[63], messages[63]);
        return { ok: true, payload: { entryIds: ["entry"], newLeafId: "leaf" } };
      },
    },
  } as unknown as WorkerConnection;
  const client = new Client(connection, { runEpoch: 1, baseLeafId: null });
  for (let index = 0; index < 100; index++) {
    await client.commit(messages);
  }
  calls = 0;
  received = 0;
  await setImmediate();
  const inspector = new Session();
  const pauses: number[] = [];
  const observer = new PerformanceObserver((list) => {
    pauses.push(...list.getEntries().map((entry) => entry.duration));
  });
  observer.observe({ entryTypes: ["gc"] });
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const load = os.loadavg();
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    await client.commit(messages);
  }
  const wallMs = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  const profile =
    mode === "allocation" ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  await setImmediate();
  await setImmediate();
  observer.disconnect();
  inspector.disconnect();
  assert.equal(calls, iterations);
  assert.equal(received, iterations * messages.length);
  console.log(
    JSON.stringify({
      arm,
      file,
      mode,
      iterations,
      messages: received,
      calls,
      wallMs,
      cpuMs: (used.user + used.system) / 1000,
      allocatedBytes: profile ? allocatedBytes(profile.profile.head) : undefined,
      gcMs: pauses.reduce((sum, pause) => sum + pause, 0),
      gcCount: pauses.length,
      gcMaxMs: Math.max(0, ...pauses),
      load,
      memory: process.memoryUsage(),
    }),
  );
}
