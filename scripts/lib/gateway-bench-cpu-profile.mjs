import { syncBuiltinESMExports } from "node:module";
import workerThreads from "node:worker_threads";

// Runtime workers select their own execArgv, so profiling flags need explicit
// propagation. Node's default profile names include both process and thread IDs.
const profileArgs = process.execArgv.filter(
  (arg) => arg === "--cpu-prof" || arg.startsWith("--cpu-prof-dir="),
);
const preloadArgs = ["--import", import.meta.filename];
const NativeWorker = workerThreads.Worker;
workerThreads.Worker = class extends NativeWorker {
  constructor(filename, options = {}) {
    const execArgv = options.execArgv ?? process.execArgv;
    super(filename, {
      ...options,
      execArgv: [
        ...execArgv,
        ...profileArgs.filter((arg) => !execArgv.includes(arg)),
        ...preloadArgs,
      ],
    });
  }
};
syncBuiltinESMExports();
