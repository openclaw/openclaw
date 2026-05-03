import { runMantisDiscordSmoke, type MantisDiscordSmokeOptions } from "./discord-smoke.runtime.js";
import { runMantisBeforeAfter, type MantisBeforeAfterOptions } from "./run.runtime.js";

export async function runMantisDiscordSmokeCommand(opts: MantisDiscordSmokeOptions) {
  const result = await runMantisDiscordSmoke(opts);
  process.stdout.write(`Mantis Discord smoke report: ${result.reportPath}\n`);
  process.stdout.write(`Mantis Discord smoke summary: ${result.summaryPath}\n`);
  if (result.status === "fail") {
    process.exitCode = 1;
  }
}

export async function runMantisBeforeAfterCommand(opts: MantisBeforeAfterOptions) {
  const result = await runMantisBeforeAfter(opts);
  process.stdout.write(`Mantis before/after report: ${result.reportPath}\n`);
  process.stdout.write(`Mantis before/after comparison: ${result.comparisonPath}\n`);
  if (result.status === "fail") {
    process.exitCode = 1;
  }
}
