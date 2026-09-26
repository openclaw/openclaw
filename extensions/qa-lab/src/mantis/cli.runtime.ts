import {
  runMantisDesktopBrowserSmoke,
  type MantisDesktopBrowserSmokeOptions,
} from "./desktop-browser-smoke.runtime.js";
import { runMantisDiscordSmoke, type MantisDiscordSmokeOptions } from "./discord-smoke.runtime.js";
import { runMantisBeforeAfter, type MantisBeforeAfterOptions } from "./run.runtime.js";
import {
  runMantisSlackDesktopSmoke,
  type MantisSlackDesktopSmokeOptions,
} from "./slack-desktop-smoke.runtime.js";
import {
  runMantisVisualDriver,
  runMantisVisualTask,
  type MantisVisualDriverOptions,
  type MantisVisualTaskOptions,
} from "./visual-task.runtime.js";

function reportMantisArtifacts(
  label: string,
  result: {
    status: "pass" | "fail";
    reportPath: string;
    summaryPath: string;
    screenshotPath?: string;
    videoPath?: string;
  },
) {
  process.stdout.write(`${label} report: ${result.reportPath}\n`);
  process.stdout.write(`${label} summary: ${result.summaryPath}\n`);
  if (result.screenshotPath) {
    process.stdout.write(`${label} screenshot: ${result.screenshotPath}\n`);
  }
  if (result.videoPath) {
    process.stdout.write(`${label} video: ${result.videoPath}\n`);
  }
}

export async function runMantisDiscordSmokeCommand(opts: MantisDiscordSmokeOptions) {
  const result = await runMantisDiscordSmoke(opts);
  reportMantisArtifacts("Mantis Discord smoke", result);
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

export async function runMantisDesktopBrowserSmokeCommand(opts: MantisDesktopBrowserSmokeOptions) {
  const result = await runMantisDesktopBrowserSmoke(opts);
  reportMantisArtifacts("Mantis desktop browser", result);
  if (result.status === "fail") {
    process.exitCode = 1;
  }
}

export async function runMantisSlackDesktopSmokeCommand(opts: MantisSlackDesktopSmokeOptions) {
  const result = await runMantisSlackDesktopSmoke(opts);
  reportMantisArtifacts("Mantis Slack desktop", result);
  for (const screenshotPath of result.approvalCheckpointScreenshotPaths ?? []) {
    process.stdout.write(
      `Mantis Slack desktop approval checkpoint screenshot: ${screenshotPath}\n`,
    );
  }
  if (result.status === "fail") {
    process.exitCode = 1;
  }
}

export async function runMantisVisualDriverCommand(opts: MantisVisualDriverOptions) {
  const result = await runMantisVisualDriver(opts);
  process.stdout.write(`Mantis visual driver result: ${result.status}\n`);
  process.stdout.write(`Mantis visual driver screenshot: ${result.screenshotPath}\n`);
  if (result.status === "fail") {
    process.exitCode = 1;
  }
}

export async function runMantisVisualTaskCommand(opts: MantisVisualTaskOptions) {
  const result = await runMantisVisualTask(opts);
  reportMantisArtifacts("Mantis visual task", result);
  if (result.status === "fail") {
    process.exitCode = 1;
  }
}
