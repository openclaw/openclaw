import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CURRENT_ONLY_SCENARIO = "telegram-partial-failure-recovery";

function readSource(sourceRoot: string, relativePath: string): string | undefined {
  try {
    return readFileSync(path.join(sourceRoot, relativePath), "utf8");
  } catch {
    return undefined;
  }
}

export function isPrePartialFailureRecoveryTarget(sourceRoot: string): boolean {
  const subscriber = readSource(sourceRoot, "src/agents/embedded-agent-subscribe.ts");
  const draftStream = readSource(sourceRoot, "extensions/telegram/src/draft-stream.ts");
  const dispatch = readSource(sourceRoot, "extensions/telegram/src/bot-message-dispatch.ts");
  return Boolean(
    subscriber?.includes("void params.onPartialReply(data);") &&
    !subscriber.includes("pendingPartialReplyTasks") &&
    draftStream?.includes("flush: loop.flush,") &&
    !draftStream.includes("waitForInFlight") &&
    dispatch?.includes("enqueueDraftLaneEvent(async () =>"),
  );
}

function main(): void {
  const sourceRoot = process.argv[2];
  const selectedSha = process.env.OPENCLAW_SELECTED_SHA;
  const output = process.env.GITHUB_ENV;
  if (!sourceRoot || !selectedSha || !output) {
    throw new Error("target source, OPENCLAW_SELECTED_SHA, and GITHUB_ENV are required");
  }
  const actualSha = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (actualSha !== selectedSha) {
    throw new Error("frozen Telegram source checkout does not match package source SHA");
  }
  if (isPrePartialFailureRecoveryTarget(sourceRoot)) {
    appendFileSync(
      output,
      `OPENCLAW_NPM_TELEGRAM_OMIT_DEFAULT_SCENARIOS=${CURRENT_ONLY_SCENARIO}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
