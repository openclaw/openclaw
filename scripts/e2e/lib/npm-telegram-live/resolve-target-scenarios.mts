import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PARTIAL_FAILURE_RECOVERY_SCENARIO = "telegram-partial-failure-recovery";
const SETTLED_EMPTY_RESPONSE_SCENARIO = "telegram-empty-response-after-write-recovery";
const PROGRESS_TOOL_VISIBILITY_SCENARIO = "telegram-progress-tool-visibility";

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

export function isPreSettledEmptyResponseTarget(sourceRoot: string): boolean {
  return (
    readSource(
      sourceRoot,
      "qa/scenarios/channels/telegram-empty-response-after-write-recovery.yaml",
    ) === undefined
  );
}

export function isPreProgressToolVisibilityTarget(sourceRoot: string): boolean {
  return (
    readSource(sourceRoot, "qa/scenarios/channels/telegram-progress-tool-visibility.yaml") ===
    undefined
  );
}

export function resolveFrozenTelegramScenarioOmissions(sourceRoot: string): string[] {
  return [
    ...(isPrePartialFailureRecoveryTarget(sourceRoot) ? [PARTIAL_FAILURE_RECOVERY_SCENARIO] : []),
    ...(isPreSettledEmptyResponseTarget(sourceRoot) ? [SETTLED_EMPTY_RESPONSE_SCENARIO] : []),
    ...(isPreProgressToolVisibilityTarget(sourceRoot) ? [PROGRESS_TOOL_VISIBILITY_SCENARIO] : []),
  ];
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
  const omittedScenarios = resolveFrozenTelegramScenarioOmissions(sourceRoot);
  if (omittedScenarios.length > 0) {
    appendFileSync(
      output,
      `OPENCLAW_NPM_TELEGRAM_OMIT_DEFAULT_SCENARIOS=${omittedScenarios.join(",")}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
