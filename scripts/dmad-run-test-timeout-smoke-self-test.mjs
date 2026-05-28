import assert from "node:assert/strict";
import path from "node:path";
import {
  resolveTimeoutSmokeCommand,
  resolveTimeoutSmokeEnv,
  resolveTimeoutSmokeReportPathSource,
} from "./dmad-run-test-timeout-smoke.mjs";

const fixedNow = new Date("2026-05-20T21:00:00.123Z");

const defaults = resolveTimeoutSmokeEnv(
  { BASE_VAR: "kept" },
  {
    now: fixedNow,
    pid: 42,
    tmpDir: "C:\\Temp",
  },
);
assert.equal(defaults.DMAD_RUN_TEST_TOTAL_TIMEOUT_MS, "0");
assert.equal(
  defaults.DMAD_RUN_TEST_REPORT_PATH,
  path.join("C:\\Temp", "dmad-run-test-timeout-smoke-2026-05-20T210000123Z-42.json"),
);
assert.equal(defaults.BASE_VAR, "kept");
assert.equal(resolveTimeoutSmokeReportPathSource({ BASE_VAR: "kept" }), "default_temp");

const overridden = resolveTimeoutSmokeEnv(
  {
    DMAD_RUN_TEST_TOTAL_TIMEOUT_MS: "77",
    DMAD_RUN_TEST_REPORT_PATH: "X:\\existing.json",
  },
  {
    now: fixedNow,
    pid: 1,
    tmpDir: "C:\\Ignored",
  },
);
assert.equal(overridden.DMAD_RUN_TEST_TOTAL_TIMEOUT_MS, "77");
assert.equal(overridden.DMAD_RUN_TEST_REPORT_PATH, "X:\\existing.json");
assert.equal(
  resolveTimeoutSmokeReportPathSource({ DMAD_RUN_TEST_REPORT_PATH: "X:\\existing.json" }),
  "override",
);
const win32Command = resolveTimeoutSmokeCommand("win32");
assert.equal(win32Command.command, "cmd.exe");
assert.deepEqual(win32Command.args, ["/d", "/s", "/c", "pnpm dmad:run-test"]);
const linuxCommand = resolveTimeoutSmokeCommand("linux");
assert.equal(linuxCommand.command, "pnpm");
assert.deepEqual(linuxCommand.args, ["dmad:run-test"]);

console.log("[dmad-run-test-timeout-smoke-self-test] PASS");
