// Synthetic benchmark instrumentation, loaded only by its worker processes.
const { isMainThread } = require("node:worker_threads");
if (!isMainThread && process.env.PLANNER_MEASURE_LOG) {
  const fs = require("node:fs");
  const { registerHooks, syncBuiltinESMExports } = require("node:module");
  const sqlite = require("node:sqlite");
  const { DatabaseSync } = sqlite;
  const { Session } = require("node:inspector");
  const mode = process.env.PLANNER_MEASURE_MODE;
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
  let profileNumber = 0;
  if (process.env.PLANNER_MEASURE_SOURCE) {
    registerHooks({
      load(url, context, nextLoad) {
        if (url.endsWith("/src/state/openclaw-agent-execution.worker.ts")) {
          return {
            source: fs.readFileSync(process.env.PLANNER_MEASURE_SOURCE, "utf8"),
            format: "module-typescript",
            shortCircuit: true,
          };
        }
        return nextLoad(url, context);
      },
    });
  }
  let transaction;
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
        transaction = {
          start: performance.now(),
          cpu: process.threadCpuUsage(),
          usage: process.resourceUsage(),
          memory: process.memoryUsage(),
          refresh: false,
        };
        return result;
      }
      if (transaction && /PRAGMA optimize|ANALYZE main/.test(sql)) {
        transaction.refresh = true;
      }
      const result = super.exec(sql);
      if (transaction && (sql === "COMMIT" || sql === "ROLLBACK")) {
        const sample = transaction;
        transaction = undefined;
        const holdMs = performance.now() - sample.start;
        const cpu = process.threadCpuUsage(sample.cpu);
        const allocation = mode === "allocation" ? post("HeapProfiler.stopSampling") : undefined;
        const profile = mode === "profile" ? post("Profiler.stop") : undefined;
        if (sample.refresh) {
          const usage = process.resourceUsage();
          const memory = process.memoryUsage();
          fs.appendFileSync(
            process.env.PLANNER_MEASURE_LOG,
            JSON.stringify({
              holdMs,
              cpuMs: (cpu.user + cpu.system) / 1000,
              sampledBytes: allocation?.profile.samples.reduce((sum, item) => sum + item.size, 0),
              fsRead: usage.fsRead - sample.usage.fsRead,
              fsWrite: usage.fsWrite - sample.usage.fsWrite,
              heapDelta: memory.heapUsed - sample.memory.heapUsed,
              externalDelta: memory.external - sample.memory.external,
              rss: memory.rss,
            }) + "\n",
          );
          if (profile) {
            fs.writeFileSync(
              `${process.env.PLANNER_MEASURE_LOG}.${profileNumber++}.cpuprofile`,
              JSON.stringify(profile.profile),
            );
          }
        }
      }
      return result;
    }
  };
  syncBuiltinESMExports();
}
