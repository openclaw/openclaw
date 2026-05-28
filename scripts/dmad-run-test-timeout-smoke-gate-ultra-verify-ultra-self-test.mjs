import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.resolve(scriptDir, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

const gateUltraVerifyUltraCommand =
  packageJson?.scripts?.["dmad:run-test:timeout-smoke:gate:ultra:verify:ultra"];
assert.equal(
  gateUltraVerifyUltraCommand,
  "pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:full && pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:full:self-test",
);

const selfTestCommand =
  packageJson?.scripts?.["dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:self-test"];
assert.equal(
  selfTestCommand,
  "node scripts/dmad-run-test-timeout-smoke-gate-ultra-verify-ultra-self-test.mjs",
);

console.log("[dmad-run-test-timeout-smoke-gate-ultra-verify-ultra-self-test] PASS");
