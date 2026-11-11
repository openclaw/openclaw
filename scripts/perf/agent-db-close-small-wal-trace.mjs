/** Native operation timings shared by the synthetic close measurement and its workers. */
import { DatabaseSync } from "node:sqlite";
import { isMainThread, workerData, threadId } from "node:worker_threads";
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
];
export function install(buffer, root) {
  const view = new Int32Array(buffer);
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
                  : 0;
  const measure = (db, type, run) => {
    if (!Atomics.load(view, 0) || !db.location()?.startsWith(root)) {
      return run();
    }
    const store = db.location().endsWith("/agent.sqlite") ? 1 : 2;
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
            -1,
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
  install(workerData.agentCloseTrace, workerData.agentCloseRoot);
}
