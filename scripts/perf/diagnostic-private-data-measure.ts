import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPrivateData,
} from "../../src/infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../../src/infra/diagnostic-otel-listener-provenance.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    listeners: { type: "string" },
    events: { type: "string" },
    "payload-kib": { type: "string" },
    "start-at": { type: "string" },
    "allocation-start-at": { type: "string" },
  },
});
function integer(name: keyof typeof values, fallback: number, min = 1) {
  return parseStrictIntegerOption({ raw: values[name], fallback, label: name, min });
}
const listeners = integer("listeners", 1);
const events = integer("events", 12_000);
const payloadKiB = integer("payload-kib", 128);
const startAt = integer("start-at", 0, 0);
const allocationStartAt = integer("allocation-start-at", 0, 0);
const content = "synthetic diagnostic content ".repeat(Math.ceil((payloadKiB * 1024) / 29));
const privateData: DiagnosticEventPrivateData = {
  modelContent: {
    inputMessages: Array.from({ length: 64 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: content.slice(index * payloadKiB * 16, (index + 1) * payloadKiB * 16),
    })),
  },
};
const event = {
  type: "model.call.started" as const,
  runId: "synthetic-run",
  callId: "synthetic-call",
  provider: "synthetic",
  model: "synthetic-model",
};
let delivered = 0;
let optedOut = 0;
for (let index = 0; index < listeners; index++) {
  const listener = (_event: unknown, _metadata: unknown, data: DiagnosticEventPrivateData) => {
    assert(data.modelContent?.inputMessages);
    delivered++;
  };
  onTrustedInternalDiagnosticEvent(
    index === 0 ? markTrustedOtelDiagnosticListener(listener) : listener,
  );
}
// Prometheus explicitly declines private content; skill tracking only accepts skill.used.
onTrustedInternalDiagnosticEvent(
  (_event, _metadata, data) => {
    assert.equal(data.modelContent, undefined);
    optedOut++;
  },
  undefined,
  { includePrivateData: false },
);
onTrustedInternalDiagnosticEvent(() => assert.fail("filtered skill listener"), {
  include: ["skill.used"],
});

async function run(count: number) {
  for (let offset = 0; offset < count; offset += 100) {
    for (let index = offset; index < Math.min(offset + 100, count); index++) {
      emitTrustedDiagnosticEventWithPrivateData(event, privateData);
    }
    await waitForDiagnosticEventsDrained();
  }
}
async function start(deadline: number) {
  if (deadline) {
    assert(deadline > Date.now(), "missed synchronized start");
    await delay(deadline - Date.now());
  }
}

const originalClone = globalThis.structuredClone;
let privateClones = 0;
globalThis.structuredClone = (value, options) => {
  if (value === privateData) {
    privateClones++;
  }
  return originalClone(value, options);
};
try {
  await run(1);
} finally {
  globalThis.structuredClone = originalClone;
}
await run(1_000);
await start(startAt);
const cpuStartEpochMs = Date.now();
const cpuBefore = process.cpuUsage();
const started = performance.now();
await run(events);
const wallMs = performance.now() - started;
const cpu = process.cpuUsage(cpuBefore);
const cpuEndEpochMs = Date.now();

const inspector = new Session();
inspector.connect();
let profile: HeapProfiler.SamplingHeapProfile;
try {
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await start(allocationStartAt);
  await run(events);
  ({ profile } = await inspector.post("HeapProfiler.stopSampling"));
} finally {
  inspector.disconnect();
}
let bytes = 0;
let dispatchBytes = 0;
function visit(node: HeapProfiler.SamplingHeapProfileNode, owned = false) {
  const underDispatch = owned || node.callFrame.functionName === "dispatchDiagnosticEvent";
  bytes += node.selfSize;
  if (underDispatch) {
    dispatchBytes += node.selfSize;
  }
  for (const child of node.children) {
    visit(child, underDispatch);
  }
}
visit(profile.head);
assert.equal(delivered, (1_001 + 2 * events) * listeners);
assert.equal(optedOut, 1_001 + 2 * events);
console.log(
  JSON.stringify({
    node: process.version,
    listeners,
    events,
    payloadBytes: Buffer.byteLength(JSON.stringify(privateData)),
    privateClonesPerEvent: privateClones,
    cpuStartEpochMs,
    cpuEndEpochMs,
    endEpochMs: Date.now(),
    wallMs,
    cpuUsPerEvent: (cpu.user + cpu.system) / events,
    sampledBytesPerEvent: bytes / events,
    dispatchBytesPerEvent: dispatchBytes / events,
    allocationSamples: profile.samples.length,
    delivered,
    optedOut,
  }),
);
