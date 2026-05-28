import fs from "node:fs/promises";
import path from "node:path";

async function readJson(filePath, label) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`${label} not readable: ${filePath}`, { cause: error });
  }
}

async function readText(filePath, label) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`${label} not readable: ${filePath}`, { cause: error });
  }
}

async function main() {
  const repoRoot = process.cwd();
  const watchPath = path.join(repoRoot, ".openclaw", "ui", "auto-trading-watch-state.json");
  const serviceStatePath = path.join(
    repoRoot,
    ".openclaw",
    "service",
    "auto-trading-watch-service.json",
  );
  const canonicalPath = path.join(
    repoRoot,
    ".openclaw",
    "ui",
    "capital-paper-assistant-state.json",
  );
  const aliasPath = path.join(repoRoot, ".openclaw", "ui", "auto-trading-assistant-state.json");
  const loopPath = path.join(
    repoRoot,
    ".openclaw",
    "trading",
    "capital-paper-automation-loop-latest.json",
  );
  const learningSnapshotPath = path.join(
    repoRoot,
    ".openclaw",
    "ui",
    "auto-trading-learning-snapshot.json",
  );
  const learningSummaryPath = path.join(
    repoRoot,
    ".openclaw",
    "ui",
    "auto-trading-learning-summary.md",
  );
  const startupStatePath = path.join(
    repoRoot,
    ".openclaw",
    "ui",
    "auto-trading-watch-startup-state.json",
  );
  const watchState = await readJson(watchPath, "auto trading watch state");
  const serviceState = await readJson(serviceStatePath, "auto trading watch service state");
  const assistantState = await readJson(canonicalPath, "canonical assistant state");
  const aliasState = await readJson(aliasPath, "alias assistant state");
  const loopState = await readJson(loopPath, "loop state");
  const learningSnapshot = await readJson(learningSnapshotPath, "auto trading learning snapshot");
  const learningSummary = await readText(learningSummaryPath, "auto trading learning summary");
  const startupState = await readJson(startupStatePath, "auto trading startup state");

  if (watchState.schema !== "openclaw.capital.auto-trading-watch-state.v1") {
    throw new Error(`unexpected watch schema: ${watchState.schema}`);
  }
  if (watchState.loop?.status !== loopState.status) {
    throw new Error(
      `watch loop status mismatch: ${watchState.loop?.status} != ${loopState.status}`,
    );
  }
  if (watchState.assistant?.status !== assistantState.status) {
    throw new Error(
      `watch assistant status mismatch: ${watchState.assistant?.status} != ${assistantState.status}`,
    );
  }
  if (
    watchState.assistant?.fastOrderPaperPattern !== assistantState.summary?.fastOrderPaperPattern
  ) {
    throw new Error("watch assistant fast-order paper pattern mismatch");
  }
  if (
    watchState.assistant?.fastOrderPaperSuccessCount !==
    assistantState.summary?.fastOrderPaperSuccessCount
  ) {
    throw new Error("watch assistant fast-order success count mismatch");
  }
  if (
    watchState.assistant?.fastOrderPaperFailureCount !==
    assistantState.summary?.fastOrderPaperFailureCount
  ) {
    throw new Error("watch assistant fast-order failure count mismatch");
  }
  if (watchState.assistant?.name !== "類高頻自動交易助手") {
    throw new Error(`unexpected assistant name: ${watchState.assistant?.name}`);
  }
  const entrypoints = Array.isArray(watchState.assistant?.entrypoints)
    ? watchState.assistant.entrypoints
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
  if (watchState.files?.watchStatePath !== watchPath) {
    throw new Error(`unexpected watch state path: ${watchState.files?.watchStatePath}`);
  }
  if (aliasState.status !== assistantState.status) {
    throw new Error(
      `alias assistant state mismatch: ${aliasState.status} != ${assistantState.status}`,
    );
  }
  if (watchState.files?.watchStatePath !== watchPath) {
    throw new Error(`unexpected watch state path: ${watchState.files?.watchStatePath}`);
  }
  if (watchState.files?.reportPath !== loopPath) {
    throw new Error(`unexpected loop report path: ${watchState.files?.reportPath}`);
  }
  if (watchState.files?.learningSnapshotPath !== learningSnapshotPath) {
    throw new Error(`unexpected learning snapshot path: ${watchState.files?.learningSnapshotPath}`);
  }
  if (watchState.files?.learningSummaryPath !== learningSummaryPath) {
    throw new Error(`unexpected learning summary path: ${watchState.files?.learningSummaryPath}`);
  }
  const tickDiagnosticPath = path.join(
    repoRoot,
    ".openclaw",
    "quote",
    "capital-tick-diagnostic.json",
  );
  if (watchState.files?.tickDiagnosticPath !== tickDiagnosticPath) {
    throw new Error(`unexpected tick diagnostic path: ${watchState.files?.tickDiagnosticPath}`);
  }
  if (watchState.files?.startupStatePath !== startupStatePath) {
    throw new Error(`unexpected startup state path: ${watchState.files?.startupStatePath}`);
  }
  if (watchState.files?.serviceStatePath !== serviceStatePath) {
    throw new Error(`unexpected service state path: ${watchState.files?.serviceStatePath}`);
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
  if (watchState.daemon?.status !== serviceState.status) {
    throw new Error(
      `watch daemon status mismatch: ${watchState.daemon?.status} != ${serviceState.status}`,
    );
  }
  if (watchState.daemon?.pid !== serviceState.pid) {
    throw new Error(`watch daemon pid mismatch: ${watchState.daemon?.pid} != ${serviceState.pid}`);
  }
  if (watchState.daemon?.watchScript !== serviceState.watchScript) {
    throw new Error(
      `watch daemon script mismatch: ${watchState.daemon?.watchScript} != ${serviceState.watchScript}`,
    );
  }
  if (
    learningSnapshot.recommendation?.nextSafeTask !== assistantState.recommendation?.nextSafeTask
  ) {
    throw new Error("learning snapshot recommendation should mirror assistant recommendation");
  }
  if (typeof watchState.tickDiagnostic?.status !== "string") {
    throw new Error("missing watch tick diagnostic status");
  }
  if (learningSnapshot.tickDiagnostic?.status !== watchState.tickDiagnostic?.status) {
    throw new Error("learning snapshot tick diagnostic should mirror watch tick diagnostic");
  }
  if (typeof watchState.assistant?.nextSafeTask !== "string") {
    throw new Error("missing assistant next safe task");
  }
  if (typeof watchState.execution?.entry?.side !== "string") {
    throw new Error("missing watch execution entry side");
  }
  if (typeof learningSnapshot.execution?.entry?.side !== "string") {
    throw new Error("missing learning snapshot execution entry side");
  }
  if (watchState.telegramPaperLoopLearningRefresh !== undefined) {
    const refresh = watchState.telegramPaperLoopLearningRefresh;
    if (typeof refresh?.status !== "string") {
      throw new Error("missing telegram paper-loop learning refresh status");
    }
    if (refresh?.brokerCommandEnabled !== false) {
      throw new Error("telegram paper-loop learning refresh broker command must remain disabled");
    }
    if (refresh?.sentBrokerOrder !== false) {
      throw new Error("telegram paper-loop learning refresh must not send broker orders");
    }
    if (refresh?.submissionCommand !== "") {
      throw new Error("telegram paper-loop learning refresh submission command must stay empty");
    }
    if (typeof refresh?.snapshotPath !== "string") {
      throw new Error("missing telegram paper-loop learning refresh snapshot path");
    }
  }
  if (!learningSummary.includes("# OpenClaw 類高頻自動交易學習摘要")) {
    throw new Error("learning summary heading missing");
  }
  process.stdout.write("AUTO_TRADING_WATCH_STATE_CHECK=OK\n");
}

await main().catch((error) => {
  process.stderr.write(
    `auto-trading watch state check failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
