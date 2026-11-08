// Paired with fsync-tts-gateway-measure.ts; never enabled by the product.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import workerThreads, { getEnvironmentData, isMainThread } from "node:worker_threads";

const probe = getEnvironmentData("openclaw.synthetic-tts-fsync");
if (!isMainThread && probe) {
  const control = new Int32Array(probe.control);
  const original = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    if (Atomics.load(control, 0) !== 1) {
      return original(fd);
    }
    Atomics.add(control, 1, 1);
    const started = performance.now();
    try {
      Atomics.wait(control, 3, 0, probe.delayMs);
      return original(fd);
    } finally {
      Atomics.add(control, 2, Math.round((performance.now() - started) * 1000));
    }
  };
  // Retained task workers are created by a supervisor isolate with explicit execArgv.
  workerThreads.Worker = new Proxy(workerThreads.Worker, {
    construct(target, [filename, options]) {
      return new target(filename, {
        ...options,
        execArgv: [
          ...(options?.execArgv ??
            process.execArgv.filter((arg) => arg !== "--expose-gc" && arg !== "--trace-gc-nvp")),
          "--import",
          import.meta.url,
        ],
      });
    },
  });
  syncBuiltinESMExports();
}
