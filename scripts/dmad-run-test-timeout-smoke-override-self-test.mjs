import assert from "node:assert/strict";
import path from "node:path";
import {
  isOverrideSmokePathPattern,
  resolveOverrideSmokeEnv,
} from "./dmad-run-test-timeout-smoke-override.mjs";

const fixedNow = new Date("2026-05-20T22:00:00.123Z");

const defaults = resolveOverrideSmokeEnv(
  { BASE_VAR: "kept" },
  {
    now: fixedNow,
    pid: 88,
    tmpDir: "C:\\Temp",
  },
);
assert.equal(
  defaults.DMAD_RUN_TEST_REPORT_PATH,
  path.join("C:\\Temp", "dmad-timeout-smoke-override-2026-05-20T220000123Z-88.json"),
);
assert.equal(defaults.BASE_VAR, "kept");
assert.equal(isOverrideSmokePathPattern(defaults.DMAD_RUN_TEST_REPORT_PATH), true);

const overridden = resolveOverrideSmokeEnv(
  {
    DMAD_RUN_TEST_REPORT_PATH: "X:\\override-report.json",
  },
  {
    now: fixedNow,
    pid: 1,
    tmpDir: "C:\\Ignored",
  },
);
assert.equal(overridden.DMAD_RUN_TEST_REPORT_PATH, "X:\\override-report.json");
assert.equal(isOverrideSmokePathPattern(overridden.DMAD_RUN_TEST_REPORT_PATH), false);

console.log("[dmad-run-test-timeout-smoke-override-self-test] PASS");
