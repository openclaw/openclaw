// Probe retained custody reasons through the real followup completion owner.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/subagent-custody-abort-retention.ts
//   --owner /absolute/baseline-owner.ts --mode retention --operations 16
// Omit --owner for the candidate; baseline imports must resolve to this checkout.
// Alternate processes AB/BA. Retention uses 7 MiB caller contexts; timing/allocation
// use tiny contexts and default to 5,000 aborts. Add --expect-released for regression proof.
// Allocation uses a separate inspector pass; CPU from that pass is diagnostic only.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    mode: { type: "string", default: "retention" },
    operations: { type: "string" },
    "expect-released": { type: "boolean" },
  },
});
assert(global.gc, "Run with --expose-gc");
assert(["retention", "timing", "allocation"].includes(values.mode));
const operations = Number(values.operations ?? (values.mode === "retention" ? "16" : "5000"));
assert(Number.isSafeInteger(operations) && operations > 0);
const payloadBytes = values.mode === "retention" ? 7 * 1024 * 1024 : 64;
const {
  SessionFollowupCompletion,
}: typeof import("../../src/agents/subagents/completion/session-followup-completion.js") =
  await import(
    values.owner
      ? pathToFileURL(values.owner).href
      : "../../src/agents/subagents/completion/session-followup-completion.js"
  );
type Owner = ReturnType<typeof SessionFollowupCompletion.bind>;
const message = "synthetic custody revoked";
const noop = () => {};
const run = <T>(work: () => T): T => work();

function createOwner(index: number): Owner {
  return SessionFollowupCompletion.bind({
    runId: `custody-retention-${index}`,
    requesterSessionKey: "agent:main:requester",
    requesterSessionId: "synthetic-requester",
    requesterAgentId: "main",
    targetSessionKey: "agent:main:child",
    targetAgentId: "main",
    custody: { signal: new AbortController().signal, assertCurrent: noop, release: noop, run },
  });
}

function abortFromCallerContext(owner: Owner, bytes: number): WeakRef<number[]> {
  const payload = Array.from({ length: bytes / 8 }, () => 123);
  function assertDispatchCurrent() {
    // The private V8 stack frame is the only surviving path to this closure.
    assert.equal(payload.length, bytes / 8);
    const reason = new Error(message);
    owner.close(reason);
    assert.equal(owner.signal.reason, reason);
    assert.throws(
      () => owner.signal.throwIfAborted(),
      (error) => error === reason,
    );
    assert.equal(reason.message, message);
  }
  assertDispatchCurrent();
  return new WeakRef(payload);
}

function holdDispatchRequest(signal: AbortSignal): () => unknown {
  const request = {
    custody: {
      signal: AbortSignal.any([AbortSignal.any([AbortSignal.any([signal])])]),
    },
  };
  // This retained caller captures only the request, never the transient payload.
  return function assertDispatchCurrent() {
    return request.custody.signal.reason;
  };
}

async function collect() {
  for (let pass = 0; pass < 4; pass++) {
    await nextTurn();
    global.gc!();
  }
}

for (let index = 0; index < 100; index++) {
  abortFromCallerContext(createOwner(index), 64);
}
await collect();
const before = process.memoryUsage();
const hostLoadBefore = loadavg();
const held: Array<() => unknown> = [];
const payloads: Array<WeakRef<number[]>> = [];
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 1024,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const cpuBefore = process.cpuUsage();
const started = performance.now();
for (let index = 0; index < operations; index++) {
  const owner = createOwner(index);
  payloads.push(abortFromCallerContext(owner, payloadBytes));
  held.push(holdDispatchRequest(owner.signal));
  if (index % 64 === 63) {
    await nextTurn();
  }
}
const wallMs = performance.now() - started;
const cpu = process.cpuUsage(cpuBefore);
let sampledBytes: number | undefined;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  inspector.disconnect();
}
await collect();
const after = process.memoryUsage();
const retainedPayloads = payloads.filter((payload) => payload.deref() !== undefined).length;
for (const readReason of held) {
  const reason = readReason();
  assert(reason instanceof Error);
  assert.equal(reason.message, message);
}
console.log(
  JSON.stringify({
    node: process.version,
    owner: values.owner ?? "candidate",
    mode: values.mode,
    operations,
    payloadBytes,
    retainedPayloads,
    retainedPayloadBytes: retainedPayloads * payloadBytes,
    retainedHeapBytes: after.heapUsed - before.heapUsed,
    retainedHeapBytesPerReason: (after.heapUsed - before.heapUsed) / operations,
    rssBefore: before.rss,
    rssAfter: after.rss,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    cpuUsPerAbort: (cpu.user + cpu.system) / operations,
    sampledBytes,
    sampledBytesPerAbort: sampledBytes === undefined ? undefined : sampledBytes / operations,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
  }),
);
if (values["expect-released"]) {
  assert.equal(retainedPayloads, 0, "Held custody abort reasons retain caller contexts");
}
