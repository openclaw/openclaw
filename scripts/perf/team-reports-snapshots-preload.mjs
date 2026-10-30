import { syncBuiltinESMExports } from "node:module";
import workerThreads from "node:worker_threads";
import { installReportFixtureTransport } from "../../extensions/team-reports/src/report-fixture-transport.test-support.ts";

installReportFixtureTransport(
  "./run-worker.collection-fixtures.test-support.ts",
  "Team Reports benchmark attempted a real network request",
);
// Production workers set their own execArgv. Carry only this synthetic HTTP boundary.
const NativeWorker = workerThreads.Worker;
workerThreads.Worker = class extends NativeWorker {
  constructor(filename, options = {}) {
    const execArgv = options.execArgv ?? process.execArgv;
    super(filename, {
      ...options,
      execArgv: execArgv.includes(import.meta.filename)
        ? execArgv
        : [...execArgv, "--import", import.meta.filename],
    });
  }
};
syncBuiltinESMExports();
