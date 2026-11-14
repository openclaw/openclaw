import fs from "node:fs";
import { registerHooks } from "node:module";
/** Native operation timings shared by the synthetic close measurement and its workers. */
import { DatabaseSync } from "node:sqlite";
import { isMainThread, workerData, threadId, Worker } from "node:worker_threads";
import { transformSync } from "esbuild";
export const labels = [
  "sql",
  "prepare",
  "busy_timeout",
  "analysis_limit",
  "optimize",
  "analyze",
  "checkpoint-passive",
  "checkpoint-truncate",
  "integrity",
  "native-close",
  "begin",
  "commit",
  "rollback",
  "lease-delete",
  "lease-read",
  "wal-stop",
  "resource-close",
  "worker-terminate",
];
export function install(buffer, root, databasePath) {
  const view = new Int32Array(buffer);
  const traceAsync = async (label, run) => {
    if (!Atomics.load(view, 0)) {
      return await run();
    }
    const start = performance.now();
    try {
      return await run();
    } finally {
      const index = Atomics.add(view, 1, 1);
      if (index < 2048) {
        view.set(
          [
            threadId,
            labels.indexOf(label),
            Math.round((performance.now() - start) * 1000),
            -1,
            Math.round(start * 1000),
            0,
          ],
          2 + index * 6,
        );
      }
    }
  };
  globalThis.agentCloseTraceAsync = traceAsync;
  registerHooks({
    load(url, context, next) {
      if (
        /\/src\/state\/openclaw-agent-(?:db-close|db-lifecycle|execution-close|db-resources)\.ts$/.test(
          url,
        )
      ) {
        const source = fs
          .readFileSync(new URL(url), "utf8")
          .replaceAll(
            "await database.walMaintenance.stop()",
            'await globalThis.agentCloseTraceAsync("wal-stop", () => database.walMaintenance.stop())',
          )
          .replaceAll(
            "await state.database?.walMaintenance.stop()",
            'await globalThis.agentCloseTraceAsync("wal-stop", () => state.database?.walMaintenance.stop())',
          )
          .replaceAll(
            ".then(() => resource.close())",
            '.then(() => globalThis.agentCloseTraceAsync("resource-close", () => resource.close()))',
          );
        return {
          format: "module",
          source: transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code,
          shortCircuit: true,
        };
      }
      return next(url, context);
    },
  });
  const terminate = Reflect.get(Worker.prototype, "terminate");
  Worker.prototype.terminate = function () {
    return traceAsync("worker-terminate", () => terminate.call(this));
  };
  const kind = (sql) =>
    /integrity_check|quick_check|foreign_key_check/i.test(sql)
      ? 8
      : /analysis_limit/i.test(sql)
        ? 3
        : /pragma\s+optimize/i.test(sql)
          ? 4
          : /\bANALYZE\b/i.test(sql)
            ? 5
            : /wal_checkpoint\s*\(PASSIVE/i.test(sql)
              ? 6
              : /wal_checkpoint/i.test(sql)
                ? 7
                : /busy_timeout/i.test(sql)
                  ? 2
                  : /^BEGIN\b/i.test(sql)
                    ? 10
                    : /^COMMIT\b/i.test(sql)
                      ? 11
                      : /^ROLLBACK\b/i.test(sql)
                        ? 12
                        : /delete from "?agent_database_leases/i.test(sql)
                          ? 13
                          : /agent_database_leases/i.test(sql)
                            ? 14
                            : 0;
  const measure = (db, type, run) => {
    if (!Atomics.load(view, 0) || !db.location()?.startsWith(root)) {
      return run();
    }
    const store = db.location() === databasePath ? 1 : 2;
    const start = performance.now();
    const cpu = process.threadCpuUsage();
    try {
      return run();
    } finally {
      const used = process.threadCpuUsage(cpu);
      const index = Atomics.add(view, 1, 1);
      if (index < 2048) {
        const off = 2 + index * 6;
        view.set(
          [
            threadId,
            type,
            Math.round((performance.now() - start) * 1000),
            used.user + used.system,
            Math.round(start * 1000),
            store,
          ],
          off,
        );
      }
    }
  };
  const exec = Reflect.get(DatabaseSync.prototype, "exec");
  const prepare = Reflect.get(DatabaseSync.prototype, "prepare");
  const close = Reflect.get(DatabaseSync.prototype, "close");
  DatabaseSync.prototype.exec = function (sql) {
    return measure(this, kind(sql), () => exec.call(this, sql));
  };
  const observeStatement = (db, statement, sql) => {
    for (const method of ["get", "all", "run"]) {
      const original = statement[method];
      statement[method] = function (...args) {
        return measure(db, kind(sql), () => original.apply(this, args));
      };
    }
    return statement;
  };
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = measure(this, 1, () => prepare.call(this, sql));
    return observeStatement(this, statement, sql);
  };
  DatabaseSync.prototype.close = function () {
    return measure(this, 9, () => close.call(this));
  };
}
if (!isMainThread && workerData?.agentCloseTrace) {
  install(workerData.agentCloseTrace, workerData.agentCloseRoot, workerData.agentClosePath);
}
