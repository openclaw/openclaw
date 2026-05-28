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
  const snapshotPath = path.join(
    repoRoot,
    ".openclaw",
    "ui",
    "auto-trading-learning-snapshot.json",
  );
  const watchStatePath = path.join(repoRoot, ".openclaw", "ui", "auto-trading-watch-state.json");
  const summaryPath = path.join(repoRoot, ".openclaw", "ui", "auto-trading-learning-summary.md");
  const assistantStatePath = path.join(
    repoRoot,
    ".openclaw",
    "ui",
    "capital-paper-assistant-state.json",
  );
  const serviceStatePath = path.join(
    repoRoot,
    ".openclaw",
    "service",
    "auto-trading-watch-service.json",
  );
  const loopPath = path.join(
    repoRoot,
    ".openclaw",
    "trading",
    "capital-paper-automation-loop-latest.json",
  );
  const snapshot = await readJson(snapshotPath, "auto trading learning snapshot");
  const watchState = await readJson(watchStatePath, "auto trading watch state");
  const assistantState = await readJson(assistantStatePath, "canonical assistant state");
  const serviceState = await readJson(serviceStatePath, "auto trading watch service state");
  const loopState = await readJson(loopPath, "loop state");
  const summary = await readText(summaryPath, "auto trading learning summary");

  if (snapshot.schema !== "openclaw.capital.auto-trading-learning-snapshot.v1") {
    throw new Error(`unexpected snapshot schema: ${snapshot.schema}`);
  }
  if (snapshot.status !== assistantState.status) {
    throw new Error(`snapshot status mismatch: ${snapshot.status} != ${assistantState.status}`);
  }
  if (snapshot.loop?.status !== loopState.status) {
    throw new Error(`snapshot loop mismatch: ${snapshot.loop?.status} != ${loopState.status}`);
  }
  if (snapshot.watch?.status !== watchState.status) {
    throw new Error(`snapshot watch mismatch: ${snapshot.watch?.status} != ${watchState.status}`);
  }
  if (snapshot.evolution?.blockerFocus !== "freshness_recovery") {
    throw new Error(`unexpected blocker focus: ${snapshot.evolution?.blockerFocus}`);
  }
  if (
    !Array.isArray(snapshot.history?.recentStatuses) ||
    snapshot.history.recentStatuses.length === 0
  ) {
    throw new Error("missing history window");
  }
  if (snapshot.history.recentStatuses.at(-1) !== loopState.status) {
    throw new Error(
      `history tail mismatch: ${snapshot.history.recentStatuses.at(-1)} != ${loopState.status}`,
    );
  }
  if (snapshot.history.currentStatusStreak < 1) {
    throw new Error(`unexpected status streak: ${snapshot.history.currentStatusStreak}`);
  }
  if (snapshot.recommendation?.nextSafeTask !== assistantState.recommendation?.nextSafeTask) {
    throw new Error("next safe task should mirror assistant recommendation");
  }
  if (snapshot.assistant?.fastOrderPaperPattern !== assistantState.summary?.fastOrderPaperPattern) {
    throw new Error("snapshot fast-order paper pattern should mirror assistant summary");
  }
  if (snapshot.fastOrderPaperPattern?.sentBrokerOrder !== false) {
    throw new Error("snapshot fast-order paper pattern must not send broker orders");
  }
  if (snapshot.fastOrderPaperPattern?.brokerCommandEnabled !== false) {
    throw new Error("snapshot fast-order paper pattern must keep broker command disabled");
  }
  if (typeof snapshot.tickDiagnostic?.status !== "string") {
    throw new Error("missing snapshot tick diagnostic status");
  }
  if (snapshot.tickDiagnostic?.status !== watchState.tickDiagnostic?.status) {
    throw new Error("snapshot tick diagnostic should mirror watch tick diagnostic");
  }
  if (snapshot.daemon?.status !== serviceState.status) {
    throw new Error(
      `snapshot daemon status mismatch: ${snapshot.daemon?.status} != ${serviceState.status}`,
    );
  }
  if (snapshot.daemon?.pid !== serviceState.pid) {
    throw new Error(`snapshot daemon pid mismatch: ${snapshot.daemon?.pid} != ${serviceState.pid}`);
  }
  if (!Array.isArray(snapshot.collaboration?.actors)) {
    throw new Error("missing collaboration actors");
  }
  for (const actor of ["openclaw", "claude", "codex"]) {
    if (!snapshot.collaboration.actors.includes(actor)) {
      throw new Error(`missing collaboration actor: ${actor}`);
    }
  }
  if (snapshot.collaboration?.safetyBoundary !== "paper_only_until_live_gates_pass") {
    throw new Error(
      `unexpected collaboration safety boundary: ${snapshot.collaboration?.safetyBoundary}`,
    );
  }
  if (snapshot.files?.serviceStatePath !== serviceStatePath) {
    throw new Error(`unexpected service state path: ${snapshot.files?.serviceStatePath}`);
  }
  if (snapshot.files?.snapshotPath !== snapshotPath) {
    throw new Error(`unexpected snapshot path: ${snapshot.files?.snapshotPath}`);
  }
  if (snapshot.files?.summaryPath !== summaryPath) {
    throw new Error(`unexpected summary path: ${snapshot.files?.summaryPath}`);
  }
  if (typeof snapshot.execution?.entry?.side !== "string") {
    throw new Error("missing snapshot execution entry side");
  }
  if (typeof snapshot.execution?.exit?.side !== "string") {
    throw new Error("missing snapshot execution exit side");
  }
  if (!summary.includes("# OpenClaw 類高頻自動交易學習摘要")) {
    throw new Error("summary heading missing");
  }
  if (!summary.includes("tickDiagnosticStatus")) {
    throw new Error("summary tick diagnostic line missing");
  }
  if (!summary.includes("collaborationSafetyBoundary")) {
    throw new Error("summary collaboration safety boundary line missing");
  }
  if (!summary.includes("fastOrderPaperPattern")) {
    throw new Error("summary fast-order paper pattern line missing");
  }
  process.stdout.write("AUTO_TRADING_LEARNING_SNAPSHOT_CHECK=OK\n");
}

await main().catch((error) => {
  process.stderr.write(
    `auto-trading learning snapshot check failed: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
