#!/usr/bin/env -S node --import ./scripts/tsx.mjs
import { runUpgradeQualificationController } from "./lib/upgrade-qualification-controller.mjs";

try {
  await runUpgradeQualificationController(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
