import { runMantisDiscordSmoke, type MantisDiscordSmokeOptions } from "./discord-smoke.runtime.js";

export async function runMantisDiscordSmokeCommand(opts: MantisDiscordSmokeOptions) {
  const result = await runMantisDiscordSmoke(opts);
  process.stdout.write(`Mantis Discord smoke report: ${result.reportPath}\n`);
  process.stdout.write(`Mantis Discord smoke summary: ${result.summaryPath}\n`);
  if (result.status === "fail") {
    process.exitCode = 1;
  }
}
