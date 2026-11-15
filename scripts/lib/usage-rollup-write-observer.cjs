// Worker-only instrumentation for scripts/perf/usage-rollup-write-measure.ts.
const { isMainThread } = require("node:worker_threads");
if (!isMainThread && process.env.ROLLUP_MEASURE_SOURCE) {
  const fs = require("node:fs");
  const { registerHooks, syncBuiltinESMExports } = require("node:module");
  const sqlite = require("node:sqlite");
  const { DatabaseSync } = sqlite;
  const { Session } = require("node:inspector");
  const mode = process.env.ROLLUP_MEASURE_MODE;
  const log = process.env.ROLLUP_MEASURE_LOG;
  const emit = (value) => fs.appendFileSync(log, JSON.stringify(value) + "\n");
  registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith("/src/infra/session-cost-usage-partitions.worker.ts")) {
        emit({ sourceLoaded: true });
        return {
          source: fs.readFileSync(process.env.ROLLUP_MEASURE_SOURCE, "utf8"),
          format: "module-typescript",
          shortCircuit: true,
        };
      }
      return nextLoad(url, context);
    },
  });
  const inspector = new Session();
  if (mode === "allocation" || mode === "profile") {
    inspector.connect();
  }
  const post = (method, params = {}) => {
    let result;
    inspector.post(method, params, (error, value) => {
      if (error) {
        throw error;
      }
      result = value;
    });
    return result;
  };
  let measurement;
  let profileNumber = 0;
  sqlite.DatabaseSync = class extends DatabaseSync {
    exec(sql) {
      if (sql === "BEGIN IMMEDIATE") {
        if (mode === "allocation") {
          post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        if (mode === "profile") {
          post("Profiler.enable");
          post("Profiler.start");
        }
        const result = super.exec(sql);
        measurement = { started: performance.now(), cpu: process.threadCpuUsage(), records: [] };
        return result;
      }
      if (measurement && (sql === "COMMIT" || sql === "ROLLBACK")) {
        const sample = measurement;
        measurement = undefined;
        const callbackMs = performance.now() - sample.started;
        const result = super.exec(sql);
        const holdMs = performance.now() - sample.started;
        const cpu = process.threadCpuUsage(sample.cpu);
        const allocation = mode === "allocation" ? post("HeapProfiler.stopSampling") : undefined;
        const profile = mode === "profile" ? post("Profiler.stop") : undefined;
        if (
          sample.records.some(({ sql: text }) => text.startsWith('insert into "cache_entries"'))
        ) {
          const sampledBytes = allocation?.profile.samples.reduce(
            (sum, item) => sum + item.size,
            0,
          );
          if (profile) {
            fs.writeFileSync(
              `${log}.${profileNumber++}.cpuprofile`,
              JSON.stringify(profile.profile),
            );
          }
          emit({
            holdMs,
            callbackMs,
            cpuMs: (cpu.user + cpu.system) / 1000,
            sampledBytes,
            memory: process.memoryUsage(),
            records: sample.records,
          });
        }
        return result;
      }
      return super.exec(sql);
    }
    prepare(sql) {
      const statement = super.prepare(sql);
      const explain = (args) =>
        super
          .prepare("EXPLAIN QUERY PLAN " + sql)
          .all(...args)
          .map((row) => row.detail);
      if (!/^(select|insert|delete|update)\b/i.test(sql)) {
        return statement;
      }
      for (const method of ["all", "get", "run"]) {
        const original = statement[method];
        statement[method] = function (...args) {
          if (!measurement) {
            return Reflect.apply(original, this, args);
          }
          const start = performance.now();
          const result = Reflect.apply(original, this, args);
          const ms = performance.now() - start;
          const plan = mode === "plans" ? explain(args) : undefined;
          measurement.records.push({ sql, ms, plan });
          return result;
        };
      }
      return statement;
    }
  };
  syncBuiltinESMExports();
}
