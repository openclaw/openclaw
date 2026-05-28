import fs from "node:fs/promises";
import path from "node:path";

async function readJson(filePath, label) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`${label} not readable: ${filePath}`, { cause: error });
  }
}

async function main() {
  const repoRoot = process.cwd();
  const aliasPath = path.join(repoRoot, ".openclaw", "ui", "auto-trading-assistant-state.json");
  const canonicalPath = path.join(
    repoRoot,
    ".openclaw",
    "ui",
    "capital-paper-assistant-state.json",
  );
  const startupStatePath = path.join(
    repoRoot,
    ".openclaw",
    "ui",
    "auto-trading-watch-startup-state.json",
  );
  const serviceStatePath = path.join(
    repoRoot,
    ".openclaw",
    "service",
    "auto-trading-watch-service.json",
  );
  const aliasState = await readJson(aliasPath, "auto trading assistant state");
  const canonicalState = await readJson(canonicalPath, "canonical assistant state");
  const startupState = await readJson(startupStatePath, "auto trading startup state");
  const serviceState = await readJson(serviceStatePath, "auto trading watch service state");

  if (aliasState.schema !== canonicalState.schema) {
    throw new Error(`schema mismatch: ${aliasState.schema} != ${canonicalState.schema}`);
  }
  if (aliasState.status !== canonicalState.status) {
    throw new Error(`status mismatch: ${aliasState.status} != ${canonicalState.status}`);
  }
  if (aliasState.assistant?.name !== "類高頻自動交易助手") {
    throw new Error(`unexpected assistant name: ${aliasState.assistant?.name}`);
  }
  const entrypoints = Array.isArray(aliasState.assistant?.entrypoints)
    ? aliasState.assistant.entrypoints
    : [];
  if (!entrypoints.includes("pnpm capital-hft:auto-trading")) {
    throw new Error("missing capital-hft:auto-trading entrypoint");
  }
  if (!entrypoints.includes("pnpm capital-hft:auto-trading-loop")) {
    throw new Error("missing capital-hft:auto-trading-loop entrypoint");
  }
  if (!entrypoints.includes("pnpm capital-hft:auto-trading-watch")) {
    throw new Error("missing capital-hft:auto-trading-watch entrypoint");
  }
  if (!entrypoints.includes("pnpm capital-hft:auto-trading-watch:daemon")) {
    throw new Error("missing capital-hft:auto-trading-watch:daemon entrypoint");
  }
  if (!entrypoints.includes("pnpm capital-hft:auto-trading-watch:daemon-check")) {
    throw new Error("missing capital-hft:auto-trading-watch:daemon-check entrypoint");
  }
  if (!entrypoints.includes("pnpm capital-hft:auto-trading-watch:startup-install")) {
    throw new Error("missing capital-hft:auto-trading-watch:startup-install entrypoint");
  }
  if (!entrypoints.includes("pnpm capital-hft:auto-trading-watch:startup-check")) {
    throw new Error("missing capital-hft:auto-trading-watch:startup-check entrypoint");
  }
  if (typeof canonicalState.execution?.entry?.side !== "string") {
    throw new Error("missing execution entry side");
  }
  if (typeof canonicalState.execution?.exit?.side !== "string") {
    throw new Error("missing execution exit side");
  }
  if (typeof canonicalState.tick?.status !== "string") {
    throw new Error("missing tick diagnostic status");
  }
  if (typeof canonicalState.summary?.fastOrderPaperPattern !== "string") {
    throw new Error("missing assistant fast-order paper pattern summary");
  }
  if (canonicalState.fastOrderPaperPattern?.sentBrokerOrder !== false) {
    throw new Error("fast-order paper pattern must not send broker orders");
  }
  if (canonicalState.fastOrderPaperPattern?.brokerCommandEnabled !== false) {
    throw new Error("fast-order paper pattern must keep broker command disabled");
  }
  if (aliasState.summary?.fastOrderPaperPattern !== canonicalState.summary.fastOrderPaperPattern) {
    throw new Error("alias fast-order paper pattern summary mismatch");
  }
  if (typeof canonicalState.tick?.monitorRunning !== "boolean") {
    throw new Error("missing tick monitor running flag");
  }
  if (typeof canonicalState.files?.tickDiagnosticPath !== "string") {
    throw new Error("missing tick diagnostic file path");
  }
  if (canonicalState.files?.startupStatePath !== startupStatePath) {
    throw new Error(
      `unexpected startup state file path: ${canonicalState.files?.startupStatePath}`,
    );
  }
  if (startupState.schema !== "openclaw.auto-trading-watch-startup.v1") {
    throw new Error(`unexpected startup schema: ${startupState.schema}`);
  }
  if (
    startupState.launcherPath !==
    path.join(repoRoot, "scripts", "openclaw-auto-trading-watch-launch.ps1")
  ) {
    throw new Error(`unexpected startup launcher path: ${startupState.launcherPath}`);
  }
  if (serviceState.schema !== "openclaw.auto-trading-watch-service.v1") {
    throw new Error(`unexpected service schema: ${serviceState.schema}`);
  }
  process.stdout.write("AUTO_TRADING_ASSISTANT_ALIAS_CHECK=OK\n");
}

await main().catch((error) => {
  process.stderr.write(
    `auto-trading assistant alias check failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
