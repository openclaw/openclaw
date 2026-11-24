// Benchmark preload inherited by Gateway workers. Never record bindings or rows.
const fs = require("node:fs");
const path = require("node:path");
const { channel } = require("node:diagnostics_channel");
const { threadId } = require("node:worker_threads");

const directory = process.env.OPENCLAW_MEMORY_SEARCH_MEASURE_OUT;
if (directory) {
  const fd = fs.openSync(path.join(directory, `sql-${process.pid}-${threadId}.jsonl`), "a");
  const record = (event) =>
    fs.writeSync(
      fd,
      JSON.stringify({ timeNs: process.hrtime.bigint().toString(), threadId, ...event }) + "\n",
    );
  channel("openclaw.database.statement").subscribe(({ engine, sql, durationMs, outcome }) =>
    record({ kind: "diagnostic", engine, sql, durationMs, outcome }),
  );
  channel("openclaw.worker.task").subscribe(({ worker, outcome }) =>
    record({ kind: "worker", worker, outcome }),
  );
  // Direct SQLite status reads do not publish the statement diagnostic channel.
  const { DatabaseSync, StatementSync } = require("node:sqlite");
  for (const [prototype, methods] of [
    [DatabaseSync.prototype, ["exec"]],
    [StatementSync.prototype, ["get", "all", "run", "iterate"]],
  ]) {
    for (const method of methods) {
      const original = prototype[method];
      prototype[method] = function (...args) {
        const start = performance.now();
        try {
          return Reflect.apply(original, this, args);
        } finally {
          record({
            kind: "native",
            engine: "sqlite",
            sql: method === "exec" ? args[0] : this.sourceSQL,
            durationMs: performance.now() - start,
          });
        }
      };
    }
  }
  record({ kind: "observer-ready" });
}
