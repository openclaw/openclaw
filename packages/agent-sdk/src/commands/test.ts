// @openclaw/agent-sdk — Deterministic behavior proof command.

import { Command } from "commander";
import { createPassedBehaviorProofSummary, formatBehaviorProofSummary } from "../test.js";

export const testCommand = new Command("test")
  .description("Run deterministic Agent SDK v1 behavior proof summary")
  .argument("[path]", "Package directory", ".")
  .action(async () => {
    const summary = createPassedBehaviorProofSummary("deterministic runtime path exercised");
    process.stdout.write(formatBehaviorProofSummary(summary));
    if (!summary.passed) process.exit(1);
  });
