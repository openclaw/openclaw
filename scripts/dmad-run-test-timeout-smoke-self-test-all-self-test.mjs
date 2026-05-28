import assert from "node:assert/strict";
import path from "node:path";
import { timeoutSmokeSelfTestScriptPaths } from "./dmad-run-test-timeout-smoke-self-test-all.mjs";

assert.equal(timeoutSmokeSelfTestScriptPaths.length, 4);
assert.equal(new Set(timeoutSmokeSelfTestScriptPaths).size, timeoutSmokeSelfTestScriptPaths.length);

const scriptNames = timeoutSmokeSelfTestScriptPaths.map((scriptPath) => path.basename(scriptPath));
assert.deepEqual(scriptNames, [
  "dmad-run-test-timeout-smoke-self-test.mjs",
  "dmad-run-test-timeout-smoke-override-self-test.mjs",
  "dmad-run-test-timeout-smoke-override-quick-check-self-test.mjs",
  "dmad-run-test-live-smoke-self-test.mjs",
]);

console.log("[dmad-run-test-timeout-smoke-self-test-all-self-test] PASS");
