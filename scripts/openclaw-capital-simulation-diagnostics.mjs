import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "openclaw.capital.simulation-diagnostics.v1";

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EISDIR") {
      return null;
    }
    throw error;
  }
}

function parseArgs(argv) {
  return {
    writeState: argv.includes("--write-state"),
    json: argv.includes("--json"),
    check: argv.includes("--check"),
  };
}

function bool(value) {
  return value === true;
}

function metric(value, fallback = null) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function buildRuntimeErrors({ simulation, fullChain, walkForward, semiCallback }) {
  const errors = [];
  if (simulation?.schema !== "openclaw.capital.thousand-run-simulation.v1") {
    errors.push({
      id: "simulation-report-missing",
      severity: "error",
      evidence: simulation?.schema || "missing",
    });
  }
  if (fullChain?.schema !== "openclaw.capital.full-chain-simulation-gate.v1") {
    errors.push({
      id: "full-chain-report-missing",
      severity: "error",
      evidence: fullChain?.schema || "missing",
    });
  }
  if (metric(fullChain?.summary?.stageFailedCount, 1) > 0) {
    errors.push({
      id: "full-chain-stage-failed",
      severity: "error",
      evidence: fullChain.summary.stageFailedCount,
    });
  }
  if (metric(fullChain?.summary?.faultFailedCount, 1) > 0) {
    errors.push({
      id: "full-chain-fault-failed",
      severity: "error",
      evidence: fullChain.summary.faultFailedCount,
    });
  }
  if (walkForward?.schema !== "openclaw.capital.qmd-walk-forward-gate.v1") {
    errors.push({
      id: "walk-forward-report-missing",
      severity: "error",
      evidence: walkForward?.schema || "missing",
    });
  } else if (walkForward.status !== "passed") {
    errors.push({ id: "walk-forward-not-passed", severity: "error", evidence: walkForward.status });
  }
  if (semiCallback?.schema !== "openclaw.capital.telegram-semi-approval-callback.v1") {
    errors.push({
      id: "telegram-semi-callback-report-missing",
      severity: "error",
      evidence: semiCallback?.schema || "missing",
    });
  }
  return errors;
}

function buildHardBlockers({ simulation, master }) {
  const blockers = [];
  const p05Pnl = metric(simulation?.summary?.pnlPts?.p05);
  const p95Drawdown = metric(simulation?.summary?.maxDrawdownPts?.p95);
  const drawdownLimit = metric(simulation?.riskGates?.maxAllowedSimulationP95DrawdownPts, 500);
  if (p05Pnl != null && p05Pnl < 0) {
    blockers.push({
      id: "risk:negative-p05-pnl",
      severity: "high",
      evidence: `p05PnlPts=${p05Pnl}`,
      action: "保持 paper-only；加入策略權重/停損/日損風控後重跑。",
    });
  }
  if (p95Drawdown != null && p95Drawdown > drawdownLimit) {
    blockers.push({
      id: "risk:p95-drawdown-over-limit",
      severity: "high",
      evidence: `p95DrawdownPts=${p95Drawdown}, limit=${drawdownLimit}`,
      action: "加入 drawdown throttle 與 per-strategy risk budget。",
    });
  }
  for (const blocker of master?.summary?.liveBlockers || []) {
    blockers.push({
      id: blocker,
      severity: "high",
      evidence: "master checklist liveBlockers",
      action: "按送單前固定風控鏈逐項完成。",
    });
  }
  for (const symbol of master?.summary?.staleSymbols || []) {
    blockers.push({
      id: `quote:stale:${symbol}`,
      severity: "medium",
      evidence: "stale callback symbol",
      action: "不回舊價；只保留 runtime block，等 fresh matched callback。",
    });
  }
  return blockers;
}

function buildOptimizations({ simulation, fullChain, walkForward, master }) {
  const byStrategy = simulation?.byStrategy || {};
  const weakStrategies = Object.entries(byStrategy)
    .filter(([, value]) => metric(value.avgPnlPtsPerRun, 0) < 20 || metric(value.winRate, 0) < 0.47)
    .map(([strategy, value]) => ({
      strategy,
      winRate: metric(value.winRate, 0),
      avgPnlPtsPerRun: metric(value.avgPnlPtsPerRun, 0),
    }));
  return [
    {
      id: "pre-trade-risk-gate-send-path",
      priority: "P0",
      reason: "master checklist 仍列為未完成；所有 broker send path 前都要固定阻擋。",
      validation:
        "pnpm capital-hft:live-strategy:readiness:check && pnpm capital-hft:live-trading:promotion:check",
    },
    {
      id: "latency-gap-instrumentation",
      priority: "P0",
      reason: "HFT tick -> signal -> order 需要延遲與跳空證據，否則不能升真單。",
      validation: "新增 latency/gap report 後接入 master checklist。",
    },
    {
      id: "drawdown-throttle-and-risk-budget",
      priority: "P1",
      reason: `p95 drawdown=${simulation?.summary?.maxDrawdownPts?.p95 ?? "missing"}，目前高於 live limit。`,
      validation:
        "pnpm capital-hft:capital:simulation:1000 && pnpm capital-hft:capital:simulation:1000:check",
    },
    {
      id: "walk-forward-strategy-selector",
      priority: "P1",
      reason: `weakStrategies=${weakStrategies.map((item) => item.strategy).join(",") || "none"}；用 fold/strategy 穩定度決定權重，不再平均開訊號。`,
      validation:
        "pnpm capital-hft:capital:walk-forward:qmd && pnpm capital-hft:capital:walk-forward:qmd:check",
      weakStrategies,
    },
    {
      id: "overseas-64-slot-rotation",
      priority: "P2",
      reason: "全海外商品不能同時 fresh；要 64-slot 分批輪詢與 reportable cache。",
      validation: "pnpm capital-hft:quote:reportable:check",
    },
    {
      id: "simulation-diagnostics-gate",
      priority: "P2",
      reason: "本報告固定彙整 error/blocker/optimization，避免每輪手動重判。",
      validation: "pnpm capital-hft:capital:simulation-diagnostics:check",
    },
  ].map((item) => ({
    ...item,
    alreadyCoveredByFullChain:
      item.id === "simulation-diagnostics-gate"
        ? fullChain?.status === "passed" && walkForward?.status === "passed"
        : false,
    presentInMasterUnfinished: Array.isArray(master?.unfinished)
      ? master.unfinished.some((unfinished) =>
          String(unfinished.item).toLowerCase().includes(item.id.split("-")[0]),
        )
      : false,
  }));
}

function toMarkdown(report) {
  const errorRows = report.runtimeErrors.map(
    (item) => `| ${item.id} | ${item.severity} | ${String(item.evidence).replace(/\|/gu, "/")} |`,
  );
  const blockerRows = report.hardBlockers.map(
    (item) =>
      `| ${item.id} | ${item.severity} | ${item.evidence.replace(/\|/gu, "/")} | ${item.action.replace(/\|/gu, "/")} |`,
  );
  const optimizationRows = report.optimizations.map(
    (item) =>
      `| ${item.id} | ${item.priority} | ${item.reason.replace(/\|/gu, "/")} | \`${item.validation}\` |`,
  );
  return [
    "# Capital Simulation Diagnostics",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- status: ${report.status}`,
    `- decision: ${report.decision}`,
    `- runtimeErrorCount: ${report.summary.runtimeErrorCount}`,
    `- hardBlockerCount: ${report.summary.hardBlockerCount}`,
    `- optimizationCount: ${report.summary.optimizationCount}`,
    `- liveTradingEnabled: ${report.safety.liveTradingEnabled}`,
    `- writeBrokerOrders: ${report.safety.writeBrokerOrders}`,
    `- sentOrder: ${report.safety.sentOrder}`,
    "",
    "## Metrics",
    "",
    `- simulationRuns: ${report.metrics.simulationRuns}`,
    `- positiveRunRate: ${report.metrics.positiveRunRate}`,
    `- p05PnlPts: ${report.metrics.p05PnlPts}`,
    `- p95DrawdownPts: ${report.metrics.p95DrawdownPts}`,
    `- fullChainStageFailed: ${report.metrics.fullChainStageFailed}`,
    `- fullChainFaultFailed: ${report.metrics.fullChainFaultFailed}`,
    `- walkForwardTrades: ${report.metrics.walkForwardTrades}`,
    `- walkForwardPnlPts: ${report.metrics.walkForwardPnlPts}`,
    "",
    "## Runtime Errors",
    "",
    "| ID | Severity | Evidence |",
    "|---|---|---|",
    ...(errorRows.length > 0 ? errorRows : ["| none | none | no runtime error detected |"]),
    "",
    "## Hard Blockers",
    "",
    "| ID | Severity | Evidence | Action |",
    "|---|---|---|---|",
    ...blockerRows,
    "",
    "## Optimizations",
    "",
    "| ID | Priority | Reason | Validation |",
    "|---|---|---|---|",
    ...optimizationRows,
    "",
    "## Next Safe Task",
    "",
    report.nextSafeTask,
    "",
  ].join("\n");
}

export async function buildCapitalSimulationDiagnostics(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const stateRoot = path.join(repoRoot, "reports", "hermes-agent", "state");
  const [simulation, fullChain, walkForward, semiCallback, master] = await Promise.all([
    readJsonIfExists(path.join(stateRoot, "openclaw-capital-thousand-run-simulation-latest.json")),
    readJsonIfExists(
      path.join(stateRoot, "openclaw-capital-full-chain-simulation-gate-latest.json"),
    ),
    readJsonIfExists(path.join(stateRoot, "openclaw-capital-qmd-walk-forward-gate-latest.json")),
    readJsonIfExists(
      path.join(stateRoot, "openclaw-capital-telegram-semi-approval-callback-latest.json"),
    ),
    readJsonIfExists(path.join(stateRoot, "openclaw-capital-master-flow-checklist-latest.json")),
  ]);
  const runtimeErrors = buildRuntimeErrors({ simulation, fullChain, walkForward, semiCallback });
  const hardBlockers = buildHardBlockers({ simulation, master });
  const optimizations = buildOptimizations({ simulation, fullChain, walkForward, master });
  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    status: runtimeErrors.length > 0 ? "simulation_errors_found" : "simulation_clean_live_blocked",
    decision: "paper_only_do_not_promote_live",
    scope: {
      repoRoot,
      statePath: path.join(stateRoot, "openclaw-capital-simulation-diagnostics-latest.json"),
      markdownPath: path.join(stateRoot, "openclaw-capital-simulation-diagnostics-latest.md"),
    },
    summary: {
      runtimeErrorCount: runtimeErrors.length,
      hardBlockerCount: hardBlockers.length,
      optimizationCount: optimizations.length,
      fixesNowCount: simulation?.findings?.fixNow?.length ?? 0,
      addFeatureCount: simulation?.findings?.addFeatures?.length ?? 0,
    },
    metrics: {
      simulationRuns: simulation?.summary?.runs ?? 0,
      positiveRunRate: simulation?.summary?.positiveRunRate ?? null,
      p05PnlPts: simulation?.summary?.pnlPts?.p05 ?? null,
      p95DrawdownPts: simulation?.summary?.maxDrawdownPts?.p95 ?? null,
      fullChainStageFailed: fullChain?.summary?.stageFailedCount ?? null,
      fullChainFaultFailed: fullChain?.summary?.faultFailedCount ?? null,
      walkForwardTrades: walkForward?.summary?.totalTestTrades ?? 0,
      walkForwardPnlPts: walkForward?.summary?.totalTestPnlPts ?? null,
      telegramSemiCallbackStatus: semiCallback?.status ?? "missing",
    },
    safety: {
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      brokerCommandFileWrite: false,
      sentOrder: false,
      paperOnly: true,
    },
    runtimeErrors,
    hardBlockers,
    optimizations,
    nextSafeTask:
      "先完成 PreTradeRiskGate before every broker send path，並把 simulation diagnostics 納入 master checklist；仍不得啟用真單。",
  };
  if (options.writeState === true || options.check === true) {
    await writeJsonWithSha(report.scope.statePath, report);
    await writeTextWithSha(report.scope.markdownPath, toMarkdown(report));
  }
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildCapitalSimulationDiagnostics({
    repoRoot: process.cwd(),
    writeState: options.writeState,
    check: options.check,
  });
  if (options.check && report.status === "simulation_errors_found") {
    throw new Error(`CAPITAL_SIMULATION_DIAGNOSTICS_ERRORS count=${report.runtimeErrors.length}`);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(toMarkdown(report));
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
