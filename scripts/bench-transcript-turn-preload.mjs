import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import workerThreads from "node:worker_threads";
const output = process.env.OPENCLAW_TURN_TRACE;
if (output) {
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
  channel("openclaw.database.statement").subscribe((record) => {
    fs.appendFileSync(
      output,
      JSON.stringify({ ...record, at: performance.timeOrigin + performance.now() }) + "\n",
    );
  });
}
