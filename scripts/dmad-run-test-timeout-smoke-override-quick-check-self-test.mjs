import assert from "node:assert/strict";
import path from "node:path";
import {
  resolveOverrideQuickCheckEnv,
  summarizeOverrideQuickCheckReport,
} from "./dmad-run-test-timeout-smoke-override-quick-check.mjs";

const fixedNow = new Date("2026-05-21T00:00:00.123Z");

const defaults = resolveOverrideQuickCheckEnv(
  { BASE_VAR: "kept" },
  {
    now: fixedNow,
    pid: 66,
    tmpDir: "C:\\Temp",
  },
);
assert.equal(
  defaults.DMAD_RUN_TEST_REPORT_PATH,
  path.join("C:\\Temp", "custom-timeout-smoke-report-2026-05-21T000000123Z-66.json"),
);
assert.equal(defaults.BASE_VAR, "kept");

const overridden = resolveOverrideQuickCheckEnv(
  {
    DMAD_RUN_TEST_REPORT_PATH: "X:\\custom-report.json",
  },
  {
    now: fixedNow,
    pid: 77,
    tmpDir: "C:\\Ignored",
  },
);
assert.equal(overridden.DMAD_RUN_TEST_REPORT_PATH, "X:\\custom-report.json");

const summary = summarizeOverrideQuickCheckReport({
  runStatus: "timeout",
  qualityStatus: "degraded_agents",
  totalTimeoutMs: 0,
  runConfig: { totalTimeoutMs: 0 },
});
assert.deepEqual(summary, {
  runStatus: "timeout",
  qualityStatus: "degraded_agents",
  totalTimeoutMs: 0,
  runConfig_totalTimeoutMs: 0,
});

const summaryWithoutRunConfig = summarizeOverrideQuickCheckReport({
  runStatus: "timeout",
  qualityStatus: "degraded_agents",
  totalTimeoutMs: 0,
});
assert.deepEqual(summaryWithoutRunConfig, {
  runStatus: "timeout",
  qualityStatus: "degraded_agents",
  totalTimeoutMs: 0,
  runConfig_totalTimeoutMs: undefined,
});

console.log("[dmad-run-test-timeout-smoke-override-quick-check-self-test] PASS");
