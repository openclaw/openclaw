import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync, StatementSync } from "node:sqlite";
import workerThreads from "node:worker_threads";
const output = process.env.OPENCLAW_TURN_TRACE;
if (output) {
  const record = (value) =>
    fs.appendFileSync(
      output,
      JSON.stringify({ ...value, at: performance.timeOrigin + performance.now() }) + "\n",
    );
  const observeSqlite = (sql, run) => {
    try {
      return run();
    } finally {
      record({
        engine: "sqlite",
        source: "native",
        threadId: workerThreads.threadId,
        sql,
      });
    }
  };
  // Read-only routing handles are raw DatabaseSync objects. Count native
  // executions too, instead of counting only the writer's EngineConnection.
  for (const [prototype, methods] of [
    [StatementSync.prototype, ["all", "get", "run", "iterate"]],
    [DatabaseSync.prototype, ["exec"]],
  ]) {
    for (const method of methods) {
      prototype[method] = new Proxy(prototype[method], {
        apply(target, receiver, args) {
          if (method !== "iterate") {
            return observeSqlite(method === "exec" ? args[0] : receiver.sourceSQL, () =>
              Reflect.apply(target, receiver, args),
            );
          }
          const iterator = Reflect.apply(target, receiver, args);
          const next = iterator.next;
          let counted = false;
          // Creating an iterator does not execute SQL. Count its first step only;
          // completion timing and outcomes are outside this work-count observer.
          iterator.next = function (...nextArgs) {
            const step = () => Reflect.apply(next, this, nextArgs);
            if (counted) {
              return step();
            }
            counted = true;
            return observeSqlite(receiver.sourceSQL, step);
          };
          return iterator;
        },
      });
    }
  }
  const OriginalWorker = workerThreads.Worker;
  workerThreads.Worker = class extends OriginalWorker {
    constructor(filename, options = {}) {
      const execArgv = options.execArgv ?? process.execArgv;
      super(filename, {
        ...options,
        execArgv: execArgv.includes(import.meta.url)
          ? execArgv
          : [...execArgv, "--import", import.meta.url],
      });
    }
  };
  syncBuiltinESMExports();
  channel("openclaw.database.statement").subscribe((value) => {
    record({ ...value, source: "diagnostic" });
  });
}
