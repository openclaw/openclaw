import { exitVitestBySignal } from "./lib/vitest-process.mts";
import { useVitestWorkerCache } from "./lib/vitest-worker-cache-policy.mts";
import type { VitestWorkerPreset } from "./lib/vitest-worker-descriptor.mts";
import { createVitestWorkerRun } from "./lib/vitest-worker-run.mts";

export async function prepareVitestWorkerCache(preset: VitestWorkerPreset = "full") {
  if (!useVitestWorkerCache(process.env, process.execArgv)) {
    throw new Error("Compiled worker cache preparation requires cache-enabled native Node");
  }
  const owner = createVitestWorkerRun(process.env, undefined, preset);
  let interrupted: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    interrupted ??= signal;
    // Disposal aborts compilation and joins its process tree before releasing the slot.
    void owner.dispose().catch(() => {});
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  try {
    await owner.prepare();
  } finally {
    try {
      await owner.dispose();
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
      if (interrupted) {
        await exitVitestBySignal(interrupted);
      }
    }
  }
}

if (import.meta.main) {
  try {
    await prepareVitestWorkerCache();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
