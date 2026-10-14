import assert from "node:assert/strict";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { mock } from "node:test";
import { parentPort } from "node:worker_threads";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type Observation = { taskId: number; counters: Int32Array };
let active: Observation | undefined;
const matches = (sql: string) => sql.includes('left join "memory_index_chunk_provenance"');
const observeRow = (row: Record<string, unknown>) => {
  if (!active) {
    return;
  }
  Atomics.add(active.counters, 2, 1);
  for (const value of Object.values(row)) {
    if (typeof value === "string") {
      Atomics.add(active.counters, 3, Buffer.byteLength(value));
    }
  }
};
const all = mock.method(StatementSync.prototype, "all");
const iterate = mock.method(StatementSync.prototype, "iterate");
StatementSync.prototype.all = function (this: StatementSync, ...args) {
  try {
    const rows = Reflect.apply(all, this, args);
    if (active && matches(this.sourceSQL)) {
      rows.forEach(observeRow);
    }
    return rows;
  } finally {
    all.mock.resetCalls();
  }
};
StatementSync.prototype.iterate = function (this: StatementSync, ...args) {
  try {
    const rows = Reflect.apply(iterate, this, args);
    if (!active || !matches(this.sourceSQL)) {
      return rows;
    }
    return (function* () {
      for (const row of rows) {
        observeRow(row);
        yield row;
      }
      return undefined;
    })();
  } finally {
    iterate.mock.resetCalls();
  }
};

function calibrate(counters: Int32Array) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE memory_index_chunk_provenance (id INTEGER)");
    const text = "native calibration 🧠";
    const query = db.prepare(
      'select ? as text from (select 1) as chunk left join "memory_index_chunk_provenance" as provenance on 0',
    );
    const beforeRows = Atomics.load(counters, 2);
    const beforeBytes = Atomics.load(counters, 3);
    assert.deepEqual(
      query.all(text).map((row) => row.text),
      [text],
    );
    assert.equal(Atomics.load(counters, 2) - beforeRows, 1);
    assert.equal(Atomics.load(counters, 3) - beforeBytes, Buffer.byteLength(text));
    Atomics.store(counters, 0, 1);
    assert.deepEqual(
      [...query.iterate(text)].map((row) => row.text),
      [text],
    );
    assert.equal(Atomics.load(counters, 2) - beforeRows, 2);
    assert.equal(Atomics.load(counters, 3) - beforeBytes, 2 * Buffer.byteLength(text));
    Atomics.store(counters, 1, 1);
  } finally {
    db.close();
  }
}

if (!parentPort) {
  throw new Error("Forget planner observation requires its actual worker port");
}
const port = parentPort;
// The canonical server accepts one task at a time. Ignore samples, resources, and exchange replies.
const observeInput = (message: unknown) => {
  const envelope = asOptionalRecord(message);
  if (
    !envelope ||
    envelope.responseId !== undefined ||
    !(envelope.nativeSections instanceof SharedArrayBuffer)
  ) {
    return;
  }
  active = undefined;
  const input = asOptionalRecord(envelope.input);
  if (
    input?.kind !== "forget-index-plan" ||
    !(input.forgetReadObservation instanceof SharedArrayBuffer)
  ) {
    return;
  }
  assert(typeof envelope.taskId === "number");
  assert.equal(input.forgetReadObservation.byteLength, 6 * Int32Array.BYTES_PER_ELEMENT);
  const counters = new Int32Array(input.forgetReadObservation);
  active = { taskId: envelope.taskId, counters };
  if (Atomics.load(counters, 0) === 0 || Atomics.load(counters, 1) === 0) {
    calibrate(counters);
  }
  Atomics.add(counters, 4, 1);
};
const postMessage = port.postMessage.bind(port);
port.postMessage = (...args) => {
  const reply = asOptionalRecord(args[0]);
  if (
    active &&
    reply?.taskId === active.taskId &&
    (reply.status === "ok" || reply.status === "failed")
  ) {
    Atomics.add(active.counters, 5, 1);
    active = undefined;
  }
  return Reflect.apply(postMessage, port, args);
};

// Install the real server before starting observation. Its message listener queues the
// handler as a microtask, so this listener records the envelope before native reads run.
await import("./memory/manager-search.worker.js");
port.on("message", observeInput);
