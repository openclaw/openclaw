// Run with Node --expose-gc --import ./scripts/tsx.mjs; synthetic live registry owners only.
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import {
  addSession,
  appendOutput,
  createProcessSession,
  deleteSession,
  getSession,
  markExited,
  prepareSessionPoll,
} from "../../src/agents/bash-process-registry.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    sessions: { type: "string" },
    callbacks: { type: "string" },
    snapshot: { type: "string" },
  },
});
assert(global.gc, "Run with --expose-gc");
const sessionCount = parseStrictIntegerOption({
  raw: values.sessions,
  fallback: 16,
  min: 1,
  label: "sessions",
});
const callbacks = parseStrictIntegerOption({
  raw: values.callbacks,
  fallback: 32,
  min: 1,
  label: "callbacks",
});
const text = "output sparse log 🦞 \ud800 completed\n";
const churn = "x".repeat(Buffer.poolSize / 2 - 8);
// Native pool backing can include extra bytes beyond the configured pool size.
const slabBytes = Buffer.from("marker").buffer.byteLength;
const sessions = Array.from({ length: sessionCount }, (_, index) => {
  const session = createProcessSession({
    id: `pool-retention-${index}`,
    command: "synthetic sparse output",
    cleanupMs: 60_000,
    startedAt: Date.now(),
    maxOutputChars: callbacks * text.length,
    pendingMaxOutputChars: callbacks * text.length,
    totalOutputChars: 0,
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    pendingOutputDropped: false,
    exited: false,
    truncated: false,
    backgrounded: true,
    cursorKeyMode: "normal",
  });
  addSession(session);
  return session;
});
async function collect() {
  await nextTurn();
  global.gc!();
  global.gc!();
}
function retainedBacking() {
  const buffers = new Set(
    sessions.flatMap((session) => session.output.entries().map((chunk) => chunk.text.buffer)),
  );
  return {
    backingStores: buffers.size,
    pooledBackingStores: [...buffers].filter((buffer) => buffer.byteLength === slabBytes).length,
    retainedBackingBytes: [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0),
    references: [...buffers].map((buffer) => new WeakRef(buffer)),
  };
}
await collect();
const before = process.memoryUsage();
for (let index = 0; index < callbacks; index++) {
  for (const session of sessions) {
    // Sparse callbacks arrive between unrelated process-wide allocations.
    for (let churnIndex = 0; churnIndex < 3; churnIndex++) {
      Buffer.from(churn);
    }
    appendOutput(session, index % 2 ? "stderr" : "stdout", text);
  }
}
for (let index = 0; index < 3; index++) {
  Buffer.from(churn);
}
await collect();
const retained = process.memoryUsage();
const { references, ...backing } = retainedBacking();
if (values.snapshot) {
  writeHeapSnapshot(values.snapshot);
}
for (const session of sessions) {
  assert.equal(getSession(session.id), session);
  assert.equal(session.aggregated, text.repeat(callbacks));
  const poll = prepareSessionPoll(session, undefined);
  assert.equal(poll.output, text.repeat(callbacks));
  assert.equal(poll.outputDropped, false);
  markExited(session, 0, null, "completed");
  assert.equal(session.aggregated, text.repeat(callbacks));
  deleteSession(session.id);
}
await collect();
const released = process.memoryUsage();
const backingStoresAfterFinish = references.filter((reference) => reference.deref()).length;
assert.equal(
  backingStoresAfterFinish,
  0,
  "Finished records must release live callback backing stores",
);
console.log(
  JSON.stringify({
    node: process.version,
    poolSize: Buffer.poolSize,
    slabBytes,
    sessions: sessionCount,
    callbacksPerSession: callbacks,
    callbackBytes: Buffer.byteLength(text, "utf16le"),
    ...backing,
    arrayBufferDelta: retained.arrayBuffers - before.arrayBuffers,
    heapDelta: retained.heapUsed - before.heapUsed,
    releasedArrayBufferDelta: released.arrayBuffers - before.arrayBuffers,
    backingStoresAfterFinish,
    exactOutput: true,
    snapshot: values.snapshot,
  }),
);
