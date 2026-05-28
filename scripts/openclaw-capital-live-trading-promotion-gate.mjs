import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-live-trading-promotion-gate-latest.json",
);
const DEFAULT_MERGE_MAP_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-angry-bohr-merge-map-latest.json",
);
const DEFAULT_PAPER_GATE_PATH = path.join(
  repoRoot,
  ".openclaw",
  "trading",
  "capital-paper-promotion-gate.json",
);
const DEFAULT_APPROVAL_PATH = path.join(repoRoot, "config", "capital-live-trading-approval.json");
const DEFAULT_SIMULATION_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-thousand-run-simulation-latest.json",
);
const DEFAULT_FULL_CHAIN_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-full-chain-simulation-gate-latest.json",
);
const DEFAULT_WALK_FORWARD_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-qmd-walk-forward-gate-latest.json",
);

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

async function readJsonOptional(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    return {
      __missing: true,
      __error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function writeJsonWithSha(filePath, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, payload, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(payload)}\n`, "ascii");
}

function passFail(ok) {
  return ok ? "pass" : "fail";
}

function check(id, ok, message, evidence = {}) {
  return {
    id,
    status: passFail(ok),
    message,
    evidence,
  };
}

function buildCapitalLiveTradingPromotionGate(options = {}) {
  const generatedAt = (options.now instanceof Date ? options.now : new Date()).toISOString();
  const mergeMap = options.mergeMap ?? {};
  const paperGate = options.paperGate ?? {};
  const approval = options.approval ?? {};
  const simulation = options.simulation ?? {};
  const fullChain = options.fullChain ?? {};
  const walkForward = options.walkForward ?? {};
  const mergeMapGate = mergeMap.liveWritePromotionGate ?? {};
  const approvalMissing = approval.__missing === true;
  const manualApprovalPresent = !approvalMissing && approval.humanApproved === true;
  const accountAllowlistReady =
    !approvalMissing &&
    Array.isArray(approval.accountAllowlist) &&
    approval.accountAllowlist.length > 0 &&
    approval.accountAllowlist.every((account) => typeof account === "string" && account.trim());
  const killSwitchReady =
    manualApprovalPresent &&
    approval.killSwitch === true &&
    typeof approval.rollbackPlan === "string" &&
    approval.rollbackPlan.trim().length > 0;
  const paperPromoted = paperGate.status === "passed" && paperGate.promoted === true;
  const simulationPresent =
    simulation.__missing !== true &&
    simulation.schema === "openclaw.capital.thousand-run-simulation.v1" &&
    Number(simulation.summary?.runs ?? 0) >= 1000;
  const simulationSafetyLocked =
    simulationPresent &&
    simulation.safety?.liveTradingEnabled === false &&
    simulation.safety?.writeBrokerOrders === false &&
    simulation.safety?.liveTradingExecution === false &&
    simulation.safety?.brokerWriteExecution === false &&
    simulation.safety?.noLiveOrderSent === true;
  const simulationRecommendation = String(simulation?.recommendation || "");
  const simulationRiskClear =
    simulationPresent &&
    ["paper_continue_no_live", "paper_only_risk_gates_enforced"].includes(
      simulationRecommendation,
    ) &&
    simulationRecommendation !== "block_until_safety_fixed" &&
    simulationRecommendation !== "paper_only_fix_risk_gates";
  const walkForwardClear =
    walkForward.__missing !== true &&
    walkForward.schema === "openclaw.capital.qmd-walk-forward-gate.v1" &&
    walkForward.status === "passed" &&
    walkForward.safety?.liveTradingEnabled === false &&
    walkForward.safety?.writeBrokerOrders === false &&
    walkForward.safety?.sentOrder === false;
  const fullChainClear =
    fullChain.__missing !== true &&
    fullChain.schema === "openclaw.capital.full-chain-simulation-gate.v1" &&
    fullChain.status === "passed" &&
    Number(fullChain.summary?.runs ?? 0) >= 1000 &&
    Number(fullChain.summary?.stageFailedCount ?? 1) === 0 &&
    Number(fullChain.summary?.faultFailedCount ?? 1) === 0 &&
    fullChain.safety?.liveTradingEnabled === false &&
    fullChain.safety?.writeBrokerOrders === false &&
    fullChain.safety?.noLiveOrderSent === true;

  const checks = [
    check(
      "live:merge-map-present",
      mergeMap.__missing !== true && mergeMap.schema === "openclaw.capital.angry-bohr-merge-map.v1",
      "Merge-map must exist and remain the source safety classifier.",
      { schema: mergeMap.schema ?? "", missing: mergeMap.__missing === true },
    ),
    check(
      "live:merge-map-live-write-blocked",
      mergeMapGate.status === "blocked" &&
        mergeMapGate.enabled === false &&
        mergeMapGate.blockerCode === "LIVE_WRITE_FORBIDDEN_IN_AUTOMATION",
      "Merge-map must keep live API, send order, and external writes blocked.",
      {
        status: mergeMapGate.status ?? "",
        enabled: mergeMapGate.enabled ?? null,
        blockerCode: mergeMapGate.blockerCode ?? "",
      },
    ),
    check(
      "live:paper-promotion-approved",
      paperPromoted,
      "Paper promotion must be approved before any live review can proceed.",
      {
        paperGateStatus: paperGate.status ?? "",
        promoted: paperGate.promoted ?? false,
        paperEligible: paperGate.summary?.paperEligible ?? false,
      },
    ),
    check(
      "live:simulation-sweep-present",
      simulationPresent,
      "1000-run simulation sweep must exist before live promotion review.",
      {
        missing: simulation.__missing === true,
        schema: simulation.schema ?? "",
        runs: simulation.summary?.runs ?? 0,
      },
    ),
    check(
      "live:simulation-safety-lock",
      simulationSafetyLocked,
      "1000-run simulation must prove no live order path was enabled.",
      {
        liveTradingEnabled: simulation.safety?.liveTradingEnabled ?? null,
        writeBrokerOrders: simulation.safety?.writeBrokerOrders ?? null,
        noLiveOrderSent: simulation.safety?.noLiveOrderSent ?? null,
      },
    ),
    check(
      "live:simulation-risk-gate-clear",
      simulationRiskClear,
      "1000-run simulation risk gate must be clear before live promotion.",
      {
        recommendation: simulation.recommendation ?? "",
        stressRiskEnforced: simulation.riskGates?.stressRiskEnforced ?? null,
        p05PnlPts: simulation.summary?.pnlPts?.p05 ?? null,
        p95MaxDrawdownPts: simulation.summary?.maxDrawdownPts?.p95 ?? null,
      },
    ),
    check(
      "live:walk-forward-gate-clear",
      walkForwardClear,
      "Walk-forward/QMD replay gate must be cleared before live promotion.",
      {
        missing: walkForward.__missing === true,
        schema: walkForward.schema ?? "",
        status: walkForward.status ?? "",
        recommendation: walkForward.recommendation ?? "",
        totalTestTrades: walkForward.summary?.totalTestTrades ?? null,
        positiveFoldRate: walkForward.summary?.positiveFoldRate ?? null,
        totalTestPnlPts: walkForward.summary?.totalTestPnlPts ?? null,
      },
    ),
    check(
      "live:full-chain-dryrun-fault-gate-clear",
      fullChainClear,
      "Full-chain quote/query/order/reply dry-run plus fault injection gate must pass before live promotion.",
      {
        missing: fullChain.__missing === true,
        schema: fullChain.schema ?? "",
        status: fullChain.status ?? "",
        runs: fullChain.summary?.runs ?? 0,
        stageFailedCount: fullChain.summary?.stageFailedCount ?? null,
        faultFailedCount: fullChain.summary?.faultFailedCount ?? null,
      },
    ),
    check(
      "live:manual-approval-file",
      manualApprovalPresent,
      "Manual approval file must exist and set humanApproved=true before live review.",
      {
        approvalMissing,
        humanApproved: approval.humanApproved ?? false,
      },
    ),
    check(
      "live:account-allowlist",
      accountAllowlistReady,
      "Manual approval must include an explicit broker account allowlist.",
      {
        accountAllowlistCount: Array.isArray(approval.accountAllowlist)
          ? approval.accountAllowlist.length
          : 0,
      },
    ),
    check(
      "live:kill-switch-and-rollback",
      killSwitchReady,
      "Manual approval must include killSwitch=true and a rollback plan.",
      {
        killSwitch: approval.killSwitch ?? false,
        hasRollbackPlan:
          typeof approval.rollbackPlan === "string" && approval.rollbackPlan.trim().length > 0,
      },
    ),
    check(
      "live:no-automatic-enable",
      true,
      "This gate never enables live trading automatically; it only reports blockers.",
      {
        liveTradingEnabled: false,
        writeTradingEnabled: false,
        sentOrder: false,
      },
    ),
  ];

  const failedChecks = checks.filter((item) => item.status !== "pass");
  const manualReady =
    failedChecks.length === 0
      ? ["LIVE_TRADING_MANUAL_REVIEW_REQUIRED"]
      : failedChecks.map((item) =>
          item.id === "live:manual-approval-file" && !approvalMissing
            ? "live:human-approval-pending"
            : item.id,
        );

  // 所有自動化檢查通過 → live_ready（仍需人工最終核准，不會自動啟用）
  const gateStatus = failedChecks.length === 0 ? "live_ready" : "blocked";

  return {
    schema: "openclaw.capital.live-trading-promotion-gate.v1",
    generatedAt,
    provider: "capital",
    mode: "live_promotion_review",
    status: gateStatus,
    readyForManualReview: failedChecks.length === 0,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    externalWriteEnabled: false,
    brokerOrderPathEnabled: false,
    loginAttempted: false,
    sentOrder: false,
    requestedCapabilities: ["live_api", "send_order", "external_write"],
    deniedCapabilities: ["live_api", "send_order", "external_write"],
    blockerCode:
      failedChecks.length === 0
        ? "LIVE_TRADING_MANUAL_REVIEW_REQUIRED"
        : "LIVE_TRADING_PROMOTION_PRECONDITIONS_FAILED",
    blockers: manualReady,
    safety: {
      allowLiveTrading: false,
      writeBrokerOrders: false,
      promoteLiveAutomatically: false,
      readOnlyPreflightOnly: true,
    },
    inputs: {
      mergeMapPath: options.mergeMapPath ?? DEFAULT_MERGE_MAP_PATH,
      paperGatePath: options.paperGatePath ?? DEFAULT_PAPER_GATE_PATH,
      approvalPath: options.approvalPath ?? DEFAULT_APPROVAL_PATH,
      simulationPath: options.simulationPath ?? DEFAULT_SIMULATION_PATH,
      fullChainPath: options.fullChainPath ?? DEFAULT_FULL_CHAIN_PATH,
      walkForwardPath: options.walkForwardPath ?? DEFAULT_WALK_FORWARD_PATH,
    },
    checks,
    nextSafeTask:
      failedChecks.length === 0
        ? "人工審查 live promotion gate；仍不可由自動化啟用 live API 或下單。"
        : !approvalMissing && !manualApprovalPresent
          ? "帳號 allowlist 可由 HFT 服務狀態自動同步；人工仍需確認 humanApproved、killSwitch、rollbackPlan；自動化仍保持 blocked。"
          : "先完成 paper promotion 與人工核准檔，再重跑 live trading promotion gate；自動化仍保持 blocked。",
  };
}

export async function runCapitalLiveTradingPromotionGate(options = {}) {
  const mergeMapPath = path.resolve(options.mergeMapPath || DEFAULT_MERGE_MAP_PATH);
  const paperGatePath = path.resolve(options.paperGatePath || DEFAULT_PAPER_GATE_PATH);
  const approvalPath = path.resolve(options.approvalPath || DEFAULT_APPROVAL_PATH);
  const simulationPath = path.resolve(options.simulationPath || DEFAULT_SIMULATION_PATH);
  const fullChainPath = path.resolve(options.fullChainPath || DEFAULT_FULL_CHAIN_PATH);
  const walkForwardPath = path.resolve(options.walkForwardPath || DEFAULT_WALK_FORWARD_PATH);
  const reportPath = path.resolve(options.reportPath || DEFAULT_REPORT_PATH);

  const report = buildCapitalLiveTradingPromotionGate({
    now: options.now,
    mergeMap: await readJsonOptional(mergeMapPath),
    paperGate: await readJsonOptional(paperGatePath),
    approval: await readJsonOptional(approvalPath),
    simulation: await readJsonOptional(simulationPath),
    fullChain: await readJsonOptional(fullChainPath),
    walkForward: await readJsonOptional(walkForwardPath),
    mergeMapPath,
    paperGatePath,
    approvalPath,
    simulationPath,
    fullChainPath,
    walkForwardPath,
  });

  if (options.writeState === true) {
    await writeJsonWithSha(reportPath, report);
  }

  return { report, reportPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const result = await runCapitalLiveTradingPromotionGate({
    mergeMapPath: argValue("--merge-map", DEFAULT_MERGE_MAP_PATH),
    paperGatePath: argValue("--paper-gate", DEFAULT_PAPER_GATE_PATH),
    approvalPath: argValue("--approval", DEFAULT_APPROVAL_PATH),
    simulationPath: argValue("--simulation", DEFAULT_SIMULATION_PATH),
    fullChainPath: argValue("--full-chain", DEFAULT_FULL_CHAIN_PATH),
    walkForwardPath: argValue("--walk-forward", DEFAULT_WALK_FORWARD_PATH),
    reportPath: argValue("--report", DEFAULT_REPORT_PATH),
    writeState: hasFlag("--write-state"),
  });

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw Capital live trading promotion gate",
        `status=${result.report.status}`,
        `blockerCode=${result.report.blockerCode}`,
        `readyForManualReview=${result.report.readyForManualReview}`,
        `nextSafeTask=${result.report.nextSafeTask}`,
      ].join("\n") + "\n",
    );
  }
}
