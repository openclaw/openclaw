import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BroadcastChannel, threadId } from "node:worker_threads";
const observations = new BroadcastChannel("cold-writer-proof");
observations.unref();
const publish = observations.postMessage.bind(observations);
const execDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec");
const prepareDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare");
assert(execDescriptor && typeof execDescriptor.value === "function");
assert(prepareDescriptor && typeof prepareDescriptor.value === "function");
const active = new WeakMap();
DatabaseSync.prototype.exec = function (sql) {
  const before = performance.now();
  const current = active.get(this);
  const result = execDescriptor.value.call(this, sql);
  if (
    this.location() === `${process.env.OPENCLAW_STATE_DIR}/agent.sqlite` &&
    /^\s*BEGIN\b/i.test(sql)
  ) {
    active.set(this, { start: performance.now(), sql });
  } else if (current && /^\s*(COMMIT|ROLLBACK)\b/i.test(sql)) {
    publish({
      type: "transaction",
      threadId,
      begin: current.sql,
      ms: performance.now() - current.start,
      sqlMs: before - current.start,
      commitMs: performance.now() - before,
    });
    active.delete(this);
  }
  return result;
};
DatabaseSync.prototype.prepare = function (sql) {
  const result = prepareDescriptor.value.call(this, sql);
  if (
    this.location() === `${process.env.OPENCLAW_STATE_DIR}/agent.sqlite` &&
    this.isTransaction &&
    /^insert into "session_transcript_cold_archives"/i.test(sql)
  ) {
    publish({ type: "archiving", threadId });
  }
  return result;
};

const closeDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "close");
assert(closeDescriptor && typeof closeDescriptor.value === "function");
DatabaseSync.prototype.close = function () {
  const tracked =
    this.isOpen && this.location() === `${process.env.OPENCLAW_STATE_DIR}/agent.sqlite`;
  const start = performance.now();
  try {
    return closeDescriptor.value.call(this);
  } finally {
    if (tracked) {
      publish({ type: "close", threadId, ms: performance.now() - start });
    }
  }
};
