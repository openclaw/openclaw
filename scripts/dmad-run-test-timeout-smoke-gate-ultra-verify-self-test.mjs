import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.resolve(scriptDir, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

const gateUltraVerifyCommand =
  packageJson?.scripts?.["dmad:run-test:timeout-smoke:gate:ultra:verify"];
assert.equal(
  gateUltraVerifyCommand,
  "pnpm dmad:run-test:timeout-smoke:gate:ultra:full && pnpm dmad:run-test:timeout-smoke:gate:ultra:full:self-test",
);

const selfTestCommand =
  packageJson?.scripts?.["dmad:run-test:timeout-smoke:gate:ultra:verify:self-test"];
assert.equal(
  selfTestCommand,
  "node scripts/dmad-run-test-timeout-smoke-gate-ultra-verify-self-test.mjs",
);

console.log("[dmad-run-test-timeout-smoke-gate-ultra-verify-self-test] PASS");
