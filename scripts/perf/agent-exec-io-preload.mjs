// Imported only by the optional synthetic IO stress harness on both measured revisions.
// Separates explicit COMMIT timing from whole native autocommit mutation calls.
// Worker operations and streaming iteration are excluded. No SQL is retained.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHistogram, performance } from "node:perf_hooks";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import { findSqlCharacter, normalizeSqlWhitespace } from "../../src/infra/sqlite-schema-sql.ts";

function isDirectDml(sql) {
  const normalized = normalizeSqlWhitespace(sql);
  if (!/^(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(normalized)) {
    return false;
  }
  const separator = findSqlCharacter(normalized, ";");
  return separator < 0 || normalized.slice(separator + 1).trim() === "";
}

if (isMainThread) {
  const originalExec = DatabaseSync.prototype.exec;
  const originalPrepare = DatabaseSync.prototype.prepare;
  const histogram = createHistogram();
  const autocommit = createHistogram();
  const statements = new WeakMap();
  const wrappers = {};
  const coverage = {
    exec: 0,
    run: 0,
    get: 0,
    all: 0,
    iterate: 0,
    untrackedStatements: 0,
    insideTransactionMutations: 0,
    excludedStreamingMutations: 0,
    autocommitFailures: 0,
    mutationOpenedTransaction: 0,
  };
  let active = false;
  let failures = 0;
  let output;
  let startedAtEpochMs;
  let before;
  const read = (file) => {
    try {
      return readFileSync(file, "utf8").trim();
    } catch (error) {
      return { unavailable: error.code };
    }
  };
  const snapshot = () => {
    const membership = read("/proc/self/cgroup");
    const relative =
      typeof membership === "string"
        ? membership
            .split("\n")
            .find((line) => line.startsWith("0::"))
            ?.slice(3)
        : undefined;
    if (!relative) {
      return { membership };
    }
    const gateway = path.join("/sys/fs/cgroup", relative);
    const agentExec = path.join(path.dirname(gateway), "agent-exec");
    return {
      membership,
      gateway: {
        ioStat: read(path.join(gateway, "io.stat")),
        ioMax: read(path.join(gateway, "io.max")),
      },
      agentExec: {
        ioStat: read(path.join(agentExec, "io.stat")),
        ioMax: read(path.join(agentExec, "io.max")),
      },
    };
  };
  const measure = (target, operation, onFailure) => {
    const started = performance.now();
    try {
      return operation();
    } catch (error) {
      onFailure();
      throw error;
    } finally {
      target.record(Math.max(1, Math.round((performance.now() - started) * 1000)));
    }
  };
  const executeMutation = (database, directDml, operation) => {
    if (!directDml) {
      return operation();
    }
    if (database.isTransaction) {
      coverage.insideTransactionMutations++;
      return operation();
    }
    const started = performance.now();
    let result;
    try {
      result = operation();
    } catch (error) {
      coverage.autocommitFailures++;
      throw error;
    }
    if (database.isTransaction) {
      coverage.mutationOpenedTransaction++;
    } else {
      autocommit.record(Math.max(1, Math.round((performance.now() - started) * 1000)));
    }
    return result;
  };
  const exec = function (sql) {
    if (!active || typeof sql !== "string") {
      return originalExec.call(this, sql);
    }
    coverage.exec++;
    if (/^\s*COMMIT(?:\s+TRANSACTION)?\s*;?\s*$/iu.test(sql)) {
      return measure(
        histogram,
        () => originalExec.call(this, sql),
        () => failures++,
      );
    }
    return executeMutation(this, isDirectDml(sql), () => originalExec.call(this, sql));
  };
  const prepare = function (sql, ...args) {
    const statement = Reflect.apply(originalPrepare, this, [sql, ...args]);
    statements.set(statement, {
      database: this,
      directDml: isDirectDml(sql),
    });
    return statement;
  };
  DatabaseSync.prototype.exec = exec;
  DatabaseSync.prototype.prepare = prepare;
  for (const method of ["run", "get", "all", "iterate"]) {
    const original = StatementSync.prototype[method];
    const wrapped = function (...args) {
      const operation = () => Reflect.apply(original, this, args);
      if (!active) {
        return operation();
      }
      coverage[method]++;
      const facts = statements.get(this);
      if (!facts) {
        coverage.untrackedStatements++;
        return operation();
      }
      if (method === "iterate") {
        coverage.excludedStreamingMutations += Number(facts.directDml);
        return operation();
      }
      return executeMutation(facts.database, facts.directDml, operation);
    };
    wrappers[method] = wrapped;
    StatementSync.prototype[method] = wrapped;
  }
  const summary = (metric) => ({
    samples: metric.count,
    p50Ms: metric.count ? metric.percentile(50) / 1000 : null,
    p95Ms: metric.count ? metric.percentile(95) / 1000 : null,
    p99Ms: metric.count ? metric.percentile(99) / 1000 : null,
    maxMs: metric.count ? metric.max / 1000 : null,
  });
  process.on("message", (message) => {
    if (message?.channel !== "team-shape-stress") {
      return;
    }
    if (message.action === "start" && typeof message.output === "string") {
      output = message.output;
      histogram.reset();
      autocommit.reset();
      for (const key of Object.keys(coverage)) {
        coverage[key] = 0;
      }
      failures = 0;
      before = snapshot();
      startedAtEpochMs = Date.now();
      active = true;
    } else if (message.action === "stop" && active) {
      active = false;
      writeFileSync(
        path.join(output, "agent-exec-io-commits.json"),
        JSON.stringify(
          {
            scope:
              "Gateway main-thread DatabaseSync.exec explicit COMMIT attempts (including failures); excludes workers and implicit/multi-statement commits",
            startedAtEpochMs,
            endedAtEpochMs: Date.now(),
            ...summary(histogram),
            failures,
            autocommitMutations: {
              scope:
                "Successful main-thread native exec/run/get/all single-statement INSERT/UPDATE/DELETE/REPLACE calls outside explicit transactions; includes statement execution and automatic commit, may include temp-table mutations; not isolated COMMIT duration. Excludes workers, WITH/CTEs, batches, and streaming iteration.",
              ...summary(autocommit),
            },
            coverage,
            wrappersInstalled: {
              exec: DatabaseSync.prototype.exec === exec,
              prepare: DatabaseSync.prototype.prepare === prepare,
              ...Object.fromEntries(
                Object.entries(wrappers).map(([method, wrapper]) => [
                  method,
                  StatementSync.prototype[method] === wrapper,
                ]),
              ),
            },
            cgroupsBefore: before,
            cgroupsAfter: snapshot(),
          },
          null,
          2,
        ),
        { flag: "wx", mode: 0o600 },
      );
    }
  });
}
