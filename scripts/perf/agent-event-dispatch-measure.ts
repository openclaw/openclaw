// Run with node --expose-gc --import ./scripts/tsx.mjs.
import { Session, type HeapProfiler } from "node:inspector/promises";
import { parseArgs } from "node:util";
import {
  emitAgentEvent,
  onAgentEvent,
  onAgentEventForRun,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
} from "../../src/infra/agent-events.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    events: { type: "string", default: "20000" },
    listeners: { type: "string", default: "8" },
    captures: { type: "string", default: "0" },
  },
});
const integer = (name: keyof typeof values, min: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
const events = integer("events", 1);
const listeners = integer("listeners", 1);
const captures = integer("captures", 0);
const warmup = 2000;
let deliveries = 0;
let captured = 0;
let unrelatedDeliveries = 0;
resetAgentEventsForTest();
for (let index = 0; index < listeners; index++) {
  const listener = () => {
    deliveries++;
  };
  if (index % 2 === 0) {
    onAgentEvent(listener);
  } else {
    onAgentEventForRun("measured", listener);
  }
  onAgentEventForRun(`unrelated-${index}`, () => {
    unrelatedDeliveries++;
  });
}
for (let index = 0; index < captures; index++) {
  onAgentRuntimeEvent(
    () => {
      deliveries++;
    },
    () => {
      captured++;
      return () => true;
    },
  );
}
const event = { runId: "measured", stream: "assistant", data: { text: "synthetic delta" } };
for (let index = 0; index < warmup; index++) {
  emitAgentEvent(event);
}
deliveries = 0;
captured = 0;
globalThis.gc?.();
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.startSampling", {
  samplingInterval: 1024,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
const start = performance.now();
for (let index = 0; index < events; index++) {
  emitAgentEvent(event);
}
const elapsedMs = performance.now() - start;
const { profile } = await inspector.post("HeapProfiler.stopSampling");
inspector.disconnect();
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
if (
  deliveries !== events * (listeners + captures) ||
  captured !== events * captures ||
  unrelatedDeliveries
) {
  throw new Error(`Incomplete delivery: ${deliveries} deliveries, ${captured} captures`);
}
console.log(
  JSON.stringify({
    events,
    listeners,
    captures,
    deliveries,
    captured,
    allocatedBytesPerEvent: allocated(profile.head) / events,
    nsPerEvent: (elapsedMs * 1e6) / events,
  }),
);
resetAgentEventsForTest();
