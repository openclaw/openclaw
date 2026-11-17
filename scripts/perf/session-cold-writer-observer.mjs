import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { BroadcastChannel, threadId } from "node:worker_threads";
const observations = new BroadcastChannel("cold-writer-proof");
observations.unref();
const publish = observations.postMessage.bind(observations);
const execDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec");
const prepareDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare");
assert(execDescriptor && typeof execDescriptor.value === "function");
assert(prepareDescriptor && typeof prepareDescriptor.value === "function");
const profileDirectory = process.env.OPENCLAW_COLD_WRITER_PROFILE_DIR;
if (profileDirectory) {
  const profiler = new Session();
  profiler.connect();
  profiler.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  profiler.post("Profiler.enable");
  profiler.post("Profiler.start");
  let finished = false;
  const finishProfile = () => {
    if (finished) {
      return;
    }
    finished = true;
    profiler.post("HeapProfiler.stopSampling", (error, result) => {
      assert.ifError(error);
      fs.writeFileSync(
        path.join(profileDirectory, `allocation-${process.pid}-${threadId}.json`),
        JSON.stringify(result.profile),
      );
    });
    profiler.post("Profiler.stop", (error, result) => {
      assert.ifError(error);
      fs.writeFileSync(
        path.join(profileDirectory, `cpu-${process.pid}-${threadId}.json`),
        JSON.stringify(result.profile),
      );
    });
    profiler.disconnect();
    publish({ type: "profile-completed", threadId });
  };
  observations.addEventListener("message", ({ data }) => {
    if (data.type === "profile-snapshot") {
      finishProfile();
    }
  });
  process.on("exit", finishProfile);
}
const active = new WeakMap();
const statements = new WeakMap();
for (const method of ["run", "get", "all", "iterate"]) {
  const descriptor = Object.getOwnPropertyDescriptor(StatementSync.prototype, method);
  assert(descriptor && typeof descriptor.value === "function");
  StatementSync.prototype[method] = function (...args) {
    const statement = statements.get(this);
    const connection = statement?.connection;
    const timed = (run) => {
      const started = performance.now();
      try {
        return run();
      } finally {
        const transaction = connection && active.get(connection);
        if (transaction) {
          if (
            /^(?:insert into|update|delete from) "(?:session_transcript_cold_archive|session_transcript_fts|session_transcript_active_event_facts|transcript_events".* set)/i.test(
              statement.sql,
            )
          ) {
            transaction.cold = true;
          }
          transaction.statementExecutionMs += performance.now() - started;
        }
      }
    };
    const result = timed(() => descriptor.value.apply(this, args));
    if (method !== "iterate") {
      return result;
    }
    const next = result.next.bind(result);
    result.next = (...nextArgs) => timed(() => next(...nextArgs));
    return result;
  };
}
DatabaseSync.prototype.exec = function (sql) {
  const before = performance.now();
  const current = active.get(this);
  const result = execDescriptor.value.call(this, sql);
  if (
    this.location() === `${process.env.OPENCLAW_STATE_DIR}/agent.sqlite` &&
    /^\s*BEGIN\b/i.test(sql)
  ) {
    active.set(this, { start: performance.now(), sql, statementExecutionMs: 0 });
  } else if (current && /^\s*(COMMIT|ROLLBACK)\b/i.test(sql)) {
    publish({
      type: "transaction",
      threadId,
      begin: current.sql,
      cold: current.cold === true,
      ms: performance.now() - current.start,
      callbackWallMs: before - current.start,
      statementExecutionMs: current.statementExecutionMs,
      callbackOtherMs: Math.max(0, before - current.start - current.statementExecutionMs),
      commitMs: performance.now() - before,
    });
    active.delete(this);
  }
  return result;
};
DatabaseSync.prototype.prepare = function (sql) {
  const result = prepareDescriptor.value.call(this, sql);
  statements.set(result, { connection: this, sql });
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
