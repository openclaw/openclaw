#!/usr/bin/env node
import { runNodeCliShim } from "./lib/tsx-cli-shim.mjs";
import { getVitestWorkerDescriptor } from "./lib/vitest-worker-descriptor.mts";

const parent = getVitestWorkerDescriptor();
const workerRun = parent
  ? (await import("./lib/vitest-worker-run.mts")).createVitestWorkerRun(process.env, parent)
  : undefined;
let shim;
try {
  shim = await runNodeCliShim(import.meta.url, {
    workerRun,
    implementation: "./run-vitest-child.mts",
    failureTool: "test",
    failureExitCode: 2,
    terminationOwner: "implementation",
    // This wrapper owns worker disposal after the shim returns, and that
    // disposal can fail the run, so the terminal marker waits for it.
    deferExitTrailer: true,
  });
} finally {
  try {
    await workerRun?.dispose({ interrupted: Boolean(shim?.interrupted) });
  } catch (error) {
    // Report a cleanup-release failure as this gate's own failure: an unhandled
    // rejection here would exit non-zero under an already-written EXIT 0.
    console.error(error);
    process.exitCode ||= 2;
  }
  shim?.reportExit();
}
