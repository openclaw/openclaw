import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.resolve(scriptDir, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

const verifyCommand = packageJson?.scripts?.["dmad:run-test:timeout-smoke:verify"];
assert.equal(
  verifyCommand,
  "pnpm dmad:run-test:timeout-smoke:self-test:all && pnpm dmad:run-test:timeout-smoke:self-test:all:self-test",
);

const selfTestCommand = packageJson?.scripts?.["dmad:run-test:timeout-smoke:verify:self-test"];
assert.equal(selfTestCommand, "node scripts/dmad-run-test-timeout-smoke-verify-self-test.mjs");

console.log("[dmad-run-test-timeout-smoke-verify-self-test] PASS");
