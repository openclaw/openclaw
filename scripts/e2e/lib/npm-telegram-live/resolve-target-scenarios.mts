import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PARTIAL_FAILURE_RECOVERY_SCENARIO = "telegram-partial-failure-recovery";
const SOURCE_GATED_SCENARIOS = [
  "telegram-empty-response-after-write-recovery",
  "telegram-prepared-delivery-recovery",
  "telegram-progress-tool-visibility",
  "telegram-provider-failure-before-output",
  "telegram-queue-invalid-mode",
  "telegram-rich-inline-composition",
  "telegram-policy-hot-reload",
  "telegram-group-policy-hot-reload",
];
const REPEATED_COMMAND_SCENARIO =
  "qa/scenarios/channels/telegram-repeated-command-authorization.yaml";
const SILENT_DENIAL = "              - waitForNoOutbound:\n                  quietMs: 3000\n";
const EXPLICIT_DENIAL =
  "              - waitForOutbound:\n" +
  "                  conversation: { id: telegram-command-room, kind: channel }\n" +
  "                  textIncludes: You are not authorized to use this command.\n" +
  "                  timeoutMs: 60000\n";

function resolveFrozenTelegramCommandScenario(sourceRoot: string): string | undefined {
  const target = readSource(sourceRoot, REPEATED_COMMAND_SCENARIO);
  if (target === undefined) {
    return undefined;
  }
  const hasExplicitDenial = target.split(EXPLICIT_DENIAL).length === 2;
  const hasSilentDenial = target.split(SILENT_DENIAL).length === 2;
  if (hasExplicitDenial === hasSilentDenial) {
    throw new Error("unrecognized frozen Telegram repeated-command denial contract");
  }
  if (!hasExplicitDenial) {
    return undefined;
  }
  // Target source selects a known contract; only trusted tooling supplies executable YAML.
  // Retire this projection when no supported frozen release returns explicit denials.
  const trustedRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const trusted = readFileSync(path.join(trustedRoot, REPEATED_COMMAND_SCENARIO), "utf8");
  if (trusted.split(SILENT_DENIAL).length !== 2 || trusted.includes(EXPLICIT_DENIAL)) {
    throw new Error("trusted Telegram repeated-command denial action changed");
  }
  return trusted.replace(SILENT_DENIAL, EXPLICIT_DENIAL);
}

function readSource(sourceRoot: string, relativePath: string): string | undefined {
  try {
    return readFileSync(path.join(sourceRoot, relativePath), "utf8");
  } catch {
    return undefined;
  }
}

function isPrePartialFailureRecoveryTarget(sourceRoot: string): boolean {
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

export function resolveFrozenTelegramScenarioOmissions(sourceRoot: string): string[] {
  return [
    ...(isPrePartialFailureRecoveryTarget(sourceRoot) ? [PARTIAL_FAILURE_RECOVERY_SCENARIO] : []),
    ...SOURCE_GATED_SCENARIOS.filter(
      (scenario) => readSource(sourceRoot, `qa/scenarios/channels/${scenario}.yaml`) === undefined,
    ),
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
  const commandScenario = resolveFrozenTelegramCommandScenario(sourceRoot);
  if (commandScenario !== undefined) {
    const overlayDir = mkdtempSync(
      path.join(path.dirname(path.resolve(sourceRoot)), "telegram-contract-"),
    );
    const overlay = path.join(overlayDir, path.basename(REPEATED_COMMAND_SCENARIO));
    writeFileSync(
      overlay,
      `# Frozen package source ${actualSha}: explicit authorization denial.\n${commandScenario}`,
    );
    appendFileSync(output, `OPENCLAW_NPM_TELEGRAM_COMMAND_SCENARIO=${overlay}\n`);
    process.stdout.write(
      `Telegram repeated-command authorization: explicit denial contract from ${actualSha}\n`,
    );
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
