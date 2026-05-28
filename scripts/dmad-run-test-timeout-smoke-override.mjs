import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runTimeoutSmoke } from "./dmad-run-test-timeout-smoke.mjs";

export function resolveOverrideSmokeEnv(
  sourceEnv = process.env,
  opts = { now: new Date(), pid: process.pid, tmpDir: os.tmpdir() },
) {
  const env = { ...sourceEnv };
  if (!env.DMAD_RUN_TEST_REPORT_PATH || env.DMAD_RUN_TEST_REPORT_PATH.trim() === "") {
    const stamp = opts.now.toISOString().replaceAll(":", "").replaceAll(".", "");
    env.DMAD_RUN_TEST_REPORT_PATH = path.join(
      opts.tmpDir,
      `dmad-timeout-smoke-override-${stamp}-${opts.pid}.json`,
    );
  }
  return env;
}

export function isOverrideSmokePathPattern(pathValue) {
  const filename = path.basename(pathValue ?? "");
  return /^dmad-timeout-smoke-override-.*\.json$/i.test(filename);
}

export function runOverrideSmoke() {
  const env = resolveOverrideSmokeEnv(process.env);
  process.env.DMAD_RUN_TEST_REPORT_PATH = env.DMAD_RUN_TEST_REPORT_PATH;
  const patternStatus = isOverrideSmokePathPattern(env.DMAD_RUN_TEST_REPORT_PATH)
    ? "match"
    : "mismatch";
  console.error(`[dmad-run-test-timeout-smoke-override] override path pattern: ${patternStatus}`);
  runTimeoutSmoke();
}

const isDirectRun = Boolean(
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url,
);

if (isDirectRun) {
  runOverrideSmoke();
}
