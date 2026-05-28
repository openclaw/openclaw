import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.resolve(scriptDir, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

const gateUltraVerifyUltraFullCommand =
  packageJson?.scripts?.["dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:full"];
assert.equal(
  gateUltraVerifyUltraFullCommand,
  "pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:ultra && pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:self-test",
);

const selfTestCommand =
  packageJson?.scripts?.["dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:full:self-test"];
assert.equal(
  selfTestCommand,
  "node scripts/dmad-run-test-timeout-smoke-gate-ultra-verify-ultra-full-self-test.mjs",
);

console.log("[dmad-run-test-timeout-smoke-gate-ultra-verify-ultra-full-self-test] PASS");
