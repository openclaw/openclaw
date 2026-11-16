import { DatabaseSync } from "node:sqlite";
import { BroadcastChannel, threadId } from "node:worker_threads";
const observations = new BroadcastChannel("cold-writer-proof");
observations.unref();
const publish = observations.postMessage.bind(observations);
const originalExec = DatabaseSync.prototype.exec;
const originalPrepare = DatabaseSync.prototype.prepare;
const active = new WeakMap();
DatabaseSync.prototype.exec = function (sql) {
  const before = performance.now();
  const current = active.get(this);
  const result = originalExec.call(this, sql);
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
  const result = originalPrepare.call(this, sql);
  if (
    this.location() === `${process.env.OPENCLAW_STATE_DIR}/agent.sqlite` &&
    this.isTransaction &&
    /^insert into "session_transcript_cold_archives"/i.test(sql)
  ) {
    publish({ type: "archiving", threadId });
  }
  return result;
};

const originalClose = DatabaseSync.prototype.close;
DatabaseSync.prototype.close = function () {
  const tracked =
    this.isOpen && this.location() === `${process.env.OPENCLAW_STATE_DIR}/agent.sqlite`;
  const start = performance.now();
  try {
    return originalClose.call(this);
  } finally {
    if (tracked) {
      publish({ type: "close", threadId, ms: performance.now() - start });
    }
  }
};
