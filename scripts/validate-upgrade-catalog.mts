#!/usr/bin/env -S node --import ./scripts/tsx.mjs
import { runUpgradeReleaseValidation } from "./lib/upgrade-release-validation.mjs";

try {
  await runUpgradeReleaseValidation(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
