/**
 * Synthetic controller-only custody measurement; no provider, database, or workspace I/O.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/steer-withdrawal-measure.ts
 *   --output <new-directory> --sessions 4096 [--baseline-dir <sparse-source-overlay>]
 * Alternate baseline/candidate processes. Repeat with --allocation for sampled allocation;
 * allocation-instrumented timings are diagnostic, separate from the uninstrumented gate.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    sessions: { type: "string", default: "4096" },
    "baseline-dir": { type: "string" },
    allocation: { type: "boolean", default: false },
  },
});
assert(values.output, "--output is required");
assert(typeof globalThis.gc === "function", "Run with --expose-gc");
const sessions = Number(values.sessions);
assert(Number.isSafeInteger(sessions) && sessions > 0 && sessions % 2 === 0);
const output = path.resolve(values.output);
mkdirSync(output);
const configPath = path.join(output, "openclaw.json");
writeFileSync(configPath, JSON.stringify({ plugins: { enabled: false } }));
process.env = createGatewayBenchEnv(output, configPath, { startupTrace: false });
if (values["baseline-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["baseline-dir"]);
  await import("./worker-retained-heap-preload.ts");
}
const sourceRoot = values["baseline-dir"] ?? fileURLToPath(new URL("../../", import.meta.url));
const sourceHashes = Object.fromEntries(
  ["steer", "mailbox-source", "message-injection-failure"].map((owner) => [
    owner,
    createHash("sha256")
      .update(readFileSync(path.join(sourceRoot, `src/sessions/session-controller.${owner}.ts`)))
      .digest("hex"),
  ]),
);
const { createReplyOperation } = await import("../../src/sessions/session-controller.operation.js");
const { submitSessionControllerSteer } =
  await import("../../src/sessions/session-controller.steer.js");
const {
  reserveSessionControllerSource,
  tryClaimSessionControllerTask,
  releaseSessionControllerClaim,
  retireSessionControllerInput,
} = await import("../../src/sessions/session-controller.mailbox.js");
const { MessageInjectionWithdrawnError } =
  await import("../../src/auto-reply/reply/message-injection-authority.js");
const makeTurn = (index: number, prefix: string) => {
  const sessionKey = `agent:main:steer-measure-${prefix}-${index}`;
  const withdrawn = index % 2 === 0;
  const operation = createReplyOperation({
    sessionKey,
    sessionId: `${prefix}-${index}`,
    resetTriggered: false,
  });
  operation.setPhase("running");
  operation.attachBackend({
    kind: "embedded",
    runId: `synthetic-run-${prefix}-${index}`,
    cancel() {},
    messageInjectionV2: {
      version: 2,
      isAvailable: () => true,
      async queueMessage() {
        throw new Error("Expected asynchronous prepared injection");
      },
      async queueMessageAsync(_text, options, authority) {
        await authority.prepareCurrent();
        authority.assertCurrent();
        options?.onQueueAccepted?.(true);
        throw withdrawn
          ? new MessageInjectionWithdrawnError("synthetic exact withdrawal at delivery deadline")
          : new Error("synthetic ambiguous receipt after acceptance");
      },
    },
  });
  const input = reserveSessionControllerSource(sessionKey, { policy: { mode: "steer" } });
  return { operation, input, withdrawn };
};
function inject(turn: ReturnType<typeof makeTurn>) {
  return submitSessionControllerSteer({
    input: turn.input,
    text: "synthetic input",
    options: { waitForTranscriptCommit: true },
  });
}
async function finish(turn: ReturnType<typeof makeTurn>) {
  turn.operation.complete();
  const claim = tryClaimSessionControllerTask(turn.input);
  if (claim) {
    releaseSessionControllerClaim(claim);
    await claim.settlement.promise;
  }
  retireSessionControllerInput(turn.input);
  await turn.input.settlement.promise;
  return Boolean(claim);
}
for (let index = 0; index < 64; index++) {
  const turn = makeTurn(index, "warm");
  await inject(turn);
  await finish(turn);
}
const turns = Array.from({ length: sessions }, (_, index) => makeTurn(index, "measured"));
globalThis.gc();
const inspector = values.allocation ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const latencyMs: number[] = [];
const counts = { withdrawn: 0, withdrawnClaimable: 0, ambiguous: 0, ambiguousClaimable: 0 };
const hostLoad = { before: loadavg(), after: [] as number[] };
const cpu = process.cpuUsage();
const started = performance.now();
for (const turn of turns) {
  const start = performance.now();
  const result = await inject(turn);
  latencyMs.push(performance.now() - start);
  assert.equal(result.status, turn.withdrawn ? "rejected" : "indeterminate");
  if (turn.withdrawn) {
    counts.withdrawn++;
  } else {
    counts.ambiguous++;
  }
}
const elapsedMs = performance.now() - started;
const usage = process.cpuUsage(cpu);
hostLoad.after = loadavg();
let sampledAllocatedBytes: number | undefined;
if (inspector) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
  sampledAllocatedBytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
  writeFileSync(path.join(output, "allocation.heapprofile"), JSON.stringify(profile));
}
// Measure settlement alone; the repaired followup's extra execution is required work.
for (const turn of turns) {
  const claimed = Number(await finish(turn));
  if (turn.withdrawn) {
    counts.withdrawnClaimable += claimed;
  } else {
    counts.ambiguousClaimable += claimed;
  }
}
latencyMs.sort((a, b) => a - b);
const result = {
  node: process.version,
  sessions,
  allocation: values.allocation,
  sourceHashes,
  counts,
  elapsedMs,
  cpuMs: (usage.user + usage.system) / 1000,
  sampledAllocatedBytes,
  samplingInterval: values.allocation ? 32768 : undefined,
  p50Ms: latencyMs[Math.ceil(sessions * 0.5) - 1],
  p95Ms: latencyMs[Math.ceil(sessions * 0.95) - 1],
  maxMs: latencyMs.at(-1),
  hostLoad,
};
writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
