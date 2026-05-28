import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.resolve(scriptDir, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

const gateUltraCommand = packageJson?.scripts?.["dmad:run-test:timeout-smoke:gate:ultra"];
assert.equal(
  gateUltraCommand,
  "pnpm dmad:run-test:timeout-smoke:gate:full && pnpm dmad:run-test:timeout-smoke:gate:self-test:all",
);

const selfTestCommand = packageJson?.scripts?.["dmad:run-test:timeout-smoke:gate:ultra:self-test"];
assert.equal(selfTestCommand, "node scripts/dmad-run-test-timeout-smoke-gate-ultra-self-test.mjs");

console.log("[dmad-run-test-timeout-smoke-gate-ultra-self-test] PASS");
