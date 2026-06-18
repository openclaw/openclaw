// @openclaw/agent-sdk — Deterministic behavior proof command.

import { Command } from "commander";
import { formatBehaviorProofSummary, runBehaviorProofs } from "../test.js";

export const testCommand = new Command("test")
  .description("Run deterministic Agent SDK v1 behavior proof summary")
  .argument("[path]", "Package directory", ".")
  .action(async (packagePath: string) => {
    const summary = await runBehaviorProofs(packagePath);
    process.stdout.write(formatBehaviorProofSummary(summary));
    if (!summary.passed) process.exit(1);
  });
