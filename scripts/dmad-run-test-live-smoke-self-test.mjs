import assert from "node:assert/strict";
import { resolveLiveSmokeCommand, resolveLiveSmokeEnv } from "./dmad-run-test-live-smoke.mjs";

const defaults = resolveLiveSmokeEnv({ BASE_VAR: "kept" });
assert.equal(defaults.DMAD_RUN_TEST_MAX_ROUNDS, "1");
assert.equal(defaults.DMAD_RUN_TEST_MOA_TIMEOUT_MS, "60000");
assert.equal(defaults.DMAD_RUN_TEST_TOTAL_TIMEOUT_MS, "360000");
assert.equal(defaults.DMAD_RUN_TEST_VERIFICATION_TIMEOUT_MS, "20000");
assert.equal(defaults.BASE_VAR, "kept");

const overridden = resolveLiveSmokeEnv({
  DMAD_RUN_TEST_MAX_ROUNDS: "2",
  DMAD_RUN_TEST_MOA_TIMEOUT_MS: "61000",
  DMAD_RUN_TEST_TOTAL_TIMEOUT_MS: "420000",
  DMAD_RUN_TEST_VERIFICATION_TIMEOUT_MS: "25000",
});
assert.equal(overridden.DMAD_RUN_TEST_MAX_ROUNDS, "2");
assert.equal(overridden.DMAD_RUN_TEST_MOA_TIMEOUT_MS, "61000");
assert.equal(overridden.DMAD_RUN_TEST_TOTAL_TIMEOUT_MS, "420000");
assert.equal(overridden.DMAD_RUN_TEST_VERIFICATION_TIMEOUT_MS, "25000");

const blankValues = resolveLiveSmokeEnv({
  DMAD_RUN_TEST_MAX_ROUNDS: " ",
  DMAD_RUN_TEST_MOA_TIMEOUT_MS: "",
  DMAD_RUN_TEST_TOTAL_TIMEOUT_MS: "  ",
  DMAD_RUN_TEST_VERIFICATION_TIMEOUT_MS: "",
});
assert.equal(blankValues.DMAD_RUN_TEST_MAX_ROUNDS, "1");
assert.equal(blankValues.DMAD_RUN_TEST_MOA_TIMEOUT_MS, "60000");
assert.equal(blankValues.DMAD_RUN_TEST_TOTAL_TIMEOUT_MS, "360000");
assert.equal(blankValues.DMAD_RUN_TEST_VERIFICATION_TIMEOUT_MS, "20000");

const win32Command = resolveLiveSmokeCommand("win32");
assert.equal(win32Command.command, "cmd.exe");
assert.deepEqual(win32Command.args, ["/d", "/s", "/c", "pnpm dmad:run-test"]);

const linuxCommand = resolveLiveSmokeCommand("linux");
assert.equal(linuxCommand.command, "pnpm");
assert.deepEqual(linuxCommand.args, ["dmad:run-test"]);

console.log("[dmad-run-test-live-smoke-self-test] PASS");
