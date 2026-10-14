#!/usr/bin/env node
import { runNodeCliShim } from "./lib/tsx-cli-shim.mjs";
import { getVitestWorkerDescriptor } from "./lib/vitest-worker-descriptor.mts";

const parent = getVitestWorkerDescriptor();
const workerRun = parent
  ? (await import("./lib/vitest-worker-run.mts")).createVitestWorkerRun(process.env, parent)
  : undefined;
try {
  await runNodeCliShim(import.meta.url, {
    workerRun,
    implementation: "./run-vitest-child.mts",
    failureTool: "test",
    failureExitCode: 2,
    terminationOwner: "implementation",
  });
} finally {
  await workerRun?.dispose();
}
