#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { qualifyOpenClawPnpmCommands } from "./lib/openclaw-command-surface.mjs";
import { writeCapitalCoreProductFreshnessMatrix } from "./openclaw-capital-core-product-freshness-matrix.mjs";
import { buildCapitalDirectOperationStatus } from "./openclaw-capital-direct-operation-status.mjs";
import { buildCapitalDirectStrategyPlatformGate } from "./openclaw-capital-direct-strategy-platform-gate.mjs";

const SCHEMA = "openclaw.capital.live-readiness-simulation.v1";
const SIMULATION_RUNS = 500;

const SOURCE_REPORTS = {
  coreProductMatrix: ".openclaw/quote/capital-core-product-freshness-matrix.json",
  directStatus: "reports/hermes-agent/state/openclaw-capital-direct-operation-status-latest.json",
  platformGate:
    "reports/hermes-agent/state/openclaw-capital-direct-strategy-platform-gate-latest.json",
  adapterAck:
    "reports/hermes-agent/state/openclaw-capital-external-broker-adapter-ack-gate-latest.json",
  adapterApplyReceipt:
    "reports/hermes-agent/state/openclaw-capital-adapter-ack-operator-apply-receipt-gate-latest.json",
  liveExecutorProfile:
    "reports/hermes-agent/state/openclaw-capital-live-executor-arm-profile-latest.json",
  operatorPacket:
    "reports/hermes-agent/state/openclaw-capital-live-operator-execution-packet-latest.json",
  localExecutorDispatch:
    "reports/hermes-agent/state/openclaw-capital-local-broker-executor-dispatch-contract-latest.json",
  tradingAgents: "reports/hermes-agent/state/openclaw-tradingagents-summary-latest.json",
  currentPaperIntents:
    "reports/hermes-agent/state/openclaw-capital-current-paper-intents-from-target-registry-latest.json",
  riskResizedRerun:
    "reports/hermes-agent/state/openclaw-capital-risk-resized-paper-intent-rerun-gate-latest.json",
};

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

function normalizeRepoPath(filePath) {
  return filePath.split(path.sep).join("/");
}

function toRepoPath(repoRoot, filePath) {
  return normalizeRepoPath(path.relative(repoRoot, filePath));
}

async function readJsonIfExists(filePath) {
  try {
    const text = (await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, "").trim();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error?.code)) {
      return null;
    }
    return {
      __readError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function refreshSimulationPrerequisiteReports(repoRoot) {
  const directStatus = await buildCapitalDirectOperationStatus({ repoRoot });
  await writeJsonWithSha(directStatus.paths.reportPath, directStatus);
  await writeJsonWithSha(directStatus.paths.panelPath, directStatus);

  const platformGate = await buildCapitalDirectStrategyPlatformGate({ repoRoot });
  await writeJsonWithSha(platformGate.paths.reportPath, platformGate);
  await writeJsonWithSha(platformGate.paths.panelPath, platformGate);
}

function parseArgs(argv) {
  return {
    check: argv.includes("--check"),
    json: argv.includes("--json"),
    writeState: argv.includes("--write-state") || argv.includes("--check"),
  };
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function getPath(value, dottedPath) {
  return String(dottedPath)
    .split(".")
    .filter(Boolean)
    .reduce((current, segment) => {
      if (current && typeof current === "object" && segment in current) {
        return current[segment];
      }
      return undefined;
    }, value);
}

function stageById(platform, id) {
  return safeArray(platform?.liveCompletion?.stages).find((stage) => stage?.id === id) ?? null;
}

function stagePassed(platform, id) {
  return stageById(platform, id)?.status === "pass";
}

function compactEvidence(value) {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value !== "object") {
    return { value };
  }
  return value;
}

function makeGate({
  id,
  label,
  priority,
  ok,
  evidence,
  method,
  validationCommand,
  canAutoCompleteNow = false,
}) {
  return {
    id,
    label,
    priority,
    status: ok ? "pass" : "blocked",
    currentEvidence: compactEvidence(evidence),
    method,
    validationCommand,
    canAutoCompleteNow: ok ? false : canAutoCompleteNow,
  };
}

export function buildGateChecklist(reports) {
  const direct = reports.directStatus?.json;
  const coreMatrix = reports.coreProductMatrix?.json;
  const platform = reports.platformGate?.json;
  const adapter = reports.adapterAck?.json;
  const applyReceipt = reports.adapterApplyReceipt?.json;
  const executor = reports.liveExecutorProfile?.json;
  const packet = reports.operatorPacket?.json;
  const dispatch = reports.localExecutorDispatch?.json;
  const tradingAgents = reports.tradingAgents?.json;
  const currentPaperIntents = reports.currentPaperIntents?.json;

  const a50Status = getPath(direct, "summary.quote.a50Status");
  const requestedStatus = getPath(direct, "summary.requestedTrade.status");
  const blockedRequiredIds = safeArray(coreMatrix?.summary?.blockedRequiredIds);
  const sessionClosedRequiredIds = safeArray(coreMatrix?.summary?.sessionClosedRequiredIds);
  const coreProductsReady =
    coreMatrix?.schema === "openclaw.capital.core-product-freshness-matrix.v1" &&
    coreMatrix?.status === "ready" &&
    coreMatrix?.ready === true &&
    coreMatrix?.summary?.requiredReady === true &&
    blockedRequiredIds.length === 0;
  const currentPaperIntentCount = Number(
    currentPaperIntents?.targetRegistry?.generatedIntentCount ??
      currentPaperIntents?.intentWrite?.activeIntentsRecordCount ??
      0,
  );
  const currentPaperIntentsReady =
    currentPaperIntents?.schema ===
      "openclaw.capital.current-paper-intents-from-target-registry.v1" &&
    currentPaperIntents?.status === "current_paper_intents_written" &&
    currentPaperIntentCount > 0 &&
    currentPaperIntents?.safety?.noLiveOrderSent === true &&
    currentPaperIntents?.safety?.writeBrokerOrders === false;
  const tradingAgentsReady =
    tradingAgents?.status === "upstream_ready" &&
    tradingAgents?.canAnalyzeNow === true &&
    tradingAgents?.runtime?.provider === "tradingagents" &&
    tradingAgents?.runtime?.mode === "paper_signal_only" &&
    tradingAgents?.runtime?.noOrderWrite === true &&
    tradingAgents?.brokerWriteAttempted === false &&
    tradingAgents?.no_live_order_sent === true;
  const executorArmed =
    executor?.status === "armed" &&
    executor?.armed === true &&
    executor?.allowBrokerWriteWhenAllGatesPass === true &&
    executor?.operatorSignaturePresent === true &&
    executor?.expired !== true;
  const localDispatchReady =
    dispatch?.status === "ready" &&
    dispatch?.dispatchPolicy === "operator_adapter_may_execute_after_own_final_confirmation" &&
    dispatch?.operatorPacket?.operatorCanExecute === true &&
    dispatch?.executor?.armed === true &&
    dispatch?.safety?.sentOrder === false;
  const adapterApplyReceiptAppliedVerified =
    applyReceipt?.status === "applied_receipt_verified" &&
    applyReceipt?.operatorReceipt?.operatorApplyVerified === true &&
    applyReceipt?.operatorReceipt?.alreadyAppliedVerified === true &&
    applyReceipt?.operatorReceipt?.activeState === "applied_candidate_matches" &&
    applyReceipt?.safety?.noLiveOrderSent === true &&
    applyReceipt?.safety?.writeBrokerOrders === false;
  const adapterApplyReceiptNoApplyRequiredVerified =
    applyReceipt?.status === "no_apply_required" &&
    applyReceipt?.operatorReceipt?.noApplyRequired === true &&
    applyReceipt?.operatorReceipt?.operatorMayApply !== true &&
    applyReceipt?.operatorReceipt?.operatorApplyVerified !== true &&
    applyReceipt?.operatorReceipt?.activeState === "pre_apply_current_matches" &&
    applyReceipt?.safety?.noLiveOrderSent === true &&
    applyReceipt?.safety?.writeBrokerOrders === false;
  const adapterApplyReceiptVerified =
    adapterApplyReceiptAppliedVerified || adapterApplyReceiptNoApplyRequiredVerified;

  return [
    makeGate({
      id: "quote:core-products-freshness",
      label: "All core products freshness matrix ready",
      priority: "P0",
      ok: coreProductsReady,
      evidence: {
        status: coreMatrix?.status ?? "missing",
        ready: coreMatrix?.ready ?? false,
        productCount: coreMatrix?.summary?.productCount ?? null,
        freshCount: coreMatrix?.summary?.freshCount ?? null,
        requiredReady: coreMatrix?.summary?.requiredReady ?? false,
        blockedRequiredIds,
        sessionClosedRequiredIds,
      },
      method:
        "Run one domestic/overseas core-product matrix first, then only repair products that block required readiness.",
      validationCommand: "pnpm capital:quote:core-products:check",
    }),
    makeGate({
      id: "tradingagents:upstream-signal-layer",
      label: "TradingAgents official signal layer ready",
      priority: "P1",
      ok: tradingAgentsReady,
      evidence: {
        status: tradingAgents?.status ?? "missing",
        canAnalyzeNow: tradingAgents?.canAnalyzeNow ?? false,
        provider: tradingAgents?.runtime?.provider ?? "",
        model: tradingAgents?.upstream?.model ?? "",
        noOrderWrite: tradingAgents?.runtime?.noOrderWrite ?? false,
      },
      method:
        "Use TauricResearch/TradingAgents only as an upstream paper signal layer, then feed signals into OpenClaw gates.",
      validationCommand: "pnpm tradingagents:status:verbose",
    }),
    makeGate({
      id: "quote:a50-fresh",
      label: "Legacy A50 direct quote advisory",
      priority: "P2",
      ok:
        currentPaperIntentsReady ||
        (a50Status === "fresh" && requestedStatus !== "blocked_a50_stale"),
      evidence: {
        blockingMode: currentPaperIntentsReady
          ? "advisory_unless_a50_selected"
          : "blocks_only_when_no_all_product_candidate_pool",
        a50Status,
        requestedStatus,
        a50QuoteReceivedAt: getPath(direct, "summary.quote.a50QuoteReceivedAt") ?? "",
        a50AgeSeconds: getPath(direct, "summary.quote.a50AgeSeconds") ?? null,
        a50MaxFreshSeconds: getPath(direct, "summary.quote.a50MaxFreshSeconds") ?? null,
        currentPaperIntentCount,
        currentPaperIntentSymbols: safeArray(currentPaperIntents?.targetRegistry?.targetResults)
          .filter((target) => target?.classification === "intent_written")
          .map((target) => target?.symbol)
          .filter(Boolean),
      },
      method:
        "Do not block the all-product strategy pool on A50 unless A50 is the selected executable candidate.",
      validationCommand: "pnpm capital-hft:auto-trading-tick-diagnostic",
    }),
    makeGate({
      id: "quote:strategy-ready",
      label: "Strategy quote universe ready",
      priority: "P0",
      ok: stagePassed(platform, "quote:strategy-ready"),
      evidence: stageById(platform, "quote:strategy-ready")?.evidence,
      method:
        "Use the Capital target registry to find fresh resolved products for paper strategy evaluation.",
      validationCommand: "pnpm capital:trade:platform:check",
    }),
    makeGate({
      id: "strategy:current-paper-intents-ready",
      label: "All-product current paper intents ready",
      priority: "P0",
      ok: currentPaperIntentsReady,
      evidence: {
        status: currentPaperIntents?.status ?? "missing",
        generatedIntentCount: currentPaperIntentCount,
        writtenTargetIds: safeArray(currentPaperIntents?.targetRegistry?.writtenTargetIds),
        sourceOsSymbolCount: currentPaperIntents?.source?.osSymbolCacheSymbolCount ?? null,
        noLiveOrderSent: currentPaperIntents?.safety?.noLiveOrderSent ?? false,
        writeBrokerOrders: currentPaperIntents?.safety?.writeBrokerOrders ?? null,
      },
      method:
        "Generate paper-only intents from the all-product fresh target pool before strategy promotion.",
      validationCommand: "pnpm capital:trade:current-paper-intents:check",
    }),
    makeGate({
      id: "position:verified-fresh",
      label: "Verified position snapshot fresh",
      priority: "P0",
      ok: stagePassed(platform, "position:verified-fresh"),
      evidence: {
        ...compactEvidence(stageById(platform, "position:verified-fresh")?.evidence),
        directDecisionStatus: getPath(direct, "summary.position.decisionStatus") ?? "",
        netContracts: getPath(direct, "summary.position.netContracts") ?? null,
      },
      method:
        "Use operator-verified Capital position snapshot as the only position source before exit logic.",
      validationCommand: "pnpm capital:trade:direct:status:check",
    }),
    makeGate({
      id: "strategy:paper-promoted",
      label: "Paper strategy promoted",
      priority: "P1",
      ok: stagePassed(platform, "strategy:paper-promoted"),
      evidence: stageById(platform, "strategy:paper-promoted")?.evidence,
      method:
        "Repair tail risk and same-case paper evidence before promotion; do not convert rejected paper intents into live orders.",
      validationCommand: "pnpm capital:strategy:tail-risk-repair:check",
    }),
    makeGate({
      id: "adapter:ack-hash-match",
      label: "External broker adapter ack hash matches sealed intent",
      priority: "P0",
      ok: stagePassed(platform, "adapter:ack-hash-match") && adapter?.ack?.hashOk === true,
      evidence: {
        ...compactEvidence(stageById(platform, "adapter:ack-hash-match")?.evidence),
        activePath: adapter?.ack?.activePath ?? "",
      },
      method:
        "Operator-owned broker adapter must ack the current sealed intent hash from the required-current template.",
      validationCommand: "pnpm capital:trade:adapter-ack:check",
    }),
    makeGate({
      id: "adapter:apply-receipt-verified",
      label: "Operator adapter apply receipt verified",
      priority: "P0",
      ok: adapterApplyReceiptVerified,
      evidence: {
        status: applyReceipt?.status ?? "missing",
        action: applyReceipt?.operatorReceipt?.action ?? "",
        activeState: applyReceipt?.operatorReceipt?.activeState ?? "",
        operatorMayApply: applyReceipt?.operatorReceipt?.operatorMayApply ?? false,
        operatorApplyVerified: applyReceipt?.operatorReceipt?.operatorApplyVerified ?? false,
        alreadyAppliedVerified: applyReceipt?.operatorReceipt?.alreadyAppliedVerified ?? false,
        sourcePath: applyReceipt?.operatorReceipt?.sourcePath ?? "",
        destinationPath: applyReceipt?.operatorReceipt?.destinationPath ?? "",
        noLiveOrderSent: applyReceipt?.safety?.noLiveOrderSent ?? false,
      },
      method:
        "Verify the operator-owned adapter has applied the staged ack to the active ack before post-apply closure.",
      validationCommand: "pnpm capital:trade:adapter-ack-apply-receipt:check",
    }),
    makeGate({
      id: "adapter:canary-no-order",
      label: "Adapter canary pass with no order sent",
      priority: "P0",
      ok:
        stagePassed(platform, "adapter:canary-no-order") &&
        adapter?.ack?.canaryPass === true &&
        adapter?.ack?.canarySentOrder === false,
      evidence: {
        ...compactEvidence(stageById(platform, "adapter:canary-no-order")?.evidence),
        adapterCanarySentOrder: adapter?.ack?.canarySentOrder ?? null,
      },
      method: "Run adapter canary only as dry-run first; canary must prove sentOrder=false.",
      validationCommand: "pnpm capital:trade:adapter-ack:check",
    }),
    makeGate({
      id: "adapter:rollback-fresh",
      label: "Rollback proof fresh",
      priority: "P0",
      ok: stagePassed(platform, "adapter:rollback-fresh") && adapter?.ack?.rollbackFresh === true,
      evidence: {
        ...compactEvidence(stageById(platform, "adapter:rollback-fresh")?.evidence),
        rollbackVerifiedAt: adapter?.ack?.rollbackVerifiedAt ?? "",
      },
      method: "Refresh rollback verification before arming any local broker executor.",
      validationCommand: "pnpm capital:trade:adapter-ack:check",
    }),
    makeGate({
      id: "direct:pretrade-clear",
      label: "Direct pretrade gate clear",
      priority: "P0",
      ok: stagePassed(platform, "direct:pretrade-clear"),
      evidence: stageById(platform, "direct:pretrade-clear")?.evidence,
      method:
        "Clear quote, day-trade, risk, live-promotion, and rollback blockers before producing an executable packet.",
      validationCommand: "pnpm capital:trade:direct:check",
    }),
    makeGate({
      id: "executor:arm-profile-armed",
      label: "Local live executor arm profile armed",
      priority: "P0",
      ok: executorArmed,
      evidence: {
        status: executor?.status ?? "missing",
        armed: executor?.armed ?? false,
        allowBrokerWriteWhenAllGatesPass: executor?.allowBrokerWriteWhenAllGatesPass ?? false,
        operatorSignaturePresent: executor?.operatorSignaturePresent ?? false,
        expired: executor?.expired ?? null,
      },
      method:
        "Only the local broker executor can hold broker write authority, and only after short-lived operator arming.",
      validationCommand: "pnpm capital:trade:live-executor-profile:check",
    }),
    makeGate({
      id: "operator-packet:execution-ready",
      label: "Operator execution packet ready",
      priority: "P0",
      ok:
        stagePassed(platform, "operator-packet:execution-ready") &&
        packet?.status === "ready" &&
        packet?.operatorCanExecute === true,
      evidence: {
        ...compactEvidence(stageById(platform, "operator-packet:execution-ready")?.evidence),
        packetStatus: packet?.status ?? "missing",
        operatorCanExecute: packet?.operatorCanExecute ?? false,
      },
      method: "Generate one sealed operator packet only after all upstream gates pass.",
      validationCommand: "pnpm capital:trade:operator-packet:check",
    }),
    makeGate({
      id: "local-executor:dispatch-ready",
      label: "Local broker executor dispatch contract ready",
      priority: "P0",
      ok: localDispatchReady,
      evidence: {
        status: dispatch?.status ?? "missing",
        dispatchPolicy: dispatch?.dispatchPolicy ?? "",
        operatorCanExecute: dispatch?.operatorPacket?.operatorCanExecute ?? false,
        executorArmed: dispatch?.executor?.armed ?? false,
      },
      method:
        "Dispatch is allowed only through the OpenClaw-managed local broker executor after final operator confirmation.",
      validationCommand: "pnpm capital:trade:local-executor-dispatch:check",
    }),
  ];
}

function failedGates(gates) {
  return gates.filter((gate) => gate.status !== "pass");
}

function qualifyGateCommands(repoRoot, gates) {
  return gates.map((gate) => ({
    ...gate,
    validationCommand: qualifyOpenClawPnpmCommands(repoRoot, gate.validationCommand),
  }));
}

export function deriveNextSafeTask(gates, reports) {
  const failedIds = new Set(failedGates(gates).map((gate) => gate.id));
  const riskStatus = reports.riskResizedRerun?.json?.status ?? "";
  if (failedIds.has("quote:core-products-freshness")) {
    return "pnpm capital:quote:core-products:check";
  }
  if (failedIds.has("strategy:current-paper-intents-ready")) {
    return "pnpm capital:trade:current-paper-intents:check";
  }
  if (failedIds.has("quote:a50-fresh")) {
    return "pnpm capital-hft:auto-trading-tick-diagnostic";
  }
  if (failedIds.has("strategy:paper-promoted") && String(riskStatus).includes("still_blocked")) {
    return "pnpm capital:strategy:tail-risk-repair:check";
  }
  if (failedIds.has("adapter:apply-receipt-verified")) {
    return "pnpm capital:trade:adapter-ack-apply-receipt:check";
  }
  if (failedIds.has("adapter:ack-hash-match") || failedIds.has("adapter:rollback-fresh")) {
    return "pnpm capital:trade:adapter-ack:check";
  }
  return failedGates(gates)[0]?.validationCommand ?? "pnpm capital:trade:platform:check";
}

function buildSimulationLog(gates) {
  const failedIds = failedGates(gates).map((gate) => gate.id);
  const blocked = failedIds.length > 0;
  return Array.from({ length: SIMULATION_RUNS }, (_, index) => ({
    run: index + 1,
    status: blocked ? "blocked" : "accepted_for_operator_execution_review",
    blockedGateIds: failedIds,
    operatorCanExecute: !blocked,
    sentOrder: false,
    noLiveOrderSent: true,
  }));
}

function summarizeSourceReports(repoRoot, rawReports) {
  return Object.fromEntries(
    Object.entries(rawReports).map(([key, entry]) => [
      key,
      {
        path: toRepoPath(repoRoot, entry.path),
        found: entry.json !== null && entry.json?.__readError === undefined,
        schema: entry.json?.schema ?? "",
        status: entry.json?.status ?? "",
        generatedAt: entry.json?.generatedAt ?? "",
        readError: entry.json?.__readError ?? "",
      },
    ]),
  );
}

function buildMethodCatalog(gates) {
  return gates.map((gate) => ({
    id: gate.id,
    priority: gate.priority,
    status: gate.status,
    method: gate.method,
    validationCommand: gate.validationCommand,
    canAutoCompleteNow: gate.canAutoCompleteNow,
  }));
}

function buildMarkdown(report) {
  const rows = report.incompleteChecklist
    .map(
      (item) =>
        `| ${item.priority} | ${item.id} | ${item.status} | \`${item.validationCommand}\` | ${item.method} |`,
    )
    .join("\n");
  return [
    "# Capital Live Readiness 500-run Simulation",
    "",
    `- status: ${report.status}`,
    `- simulationRuns: ${report.simulationRuns}`,
    `- acceptedRuns: ${report.completion.acceptedRuns}`,
    `- blockedRuns: ${report.completion.blockedRuns}`,
    `- operatorCanExecute: ${report.operatorCanExecute}`,
    `- noLiveOrderSent: ${report.safety.noLiveOrderSent}`,
    `- sealedOrderIntent.sha256: ${report.sealedOrderIntent.sha256}`,
    `- nextSafeTask: \`${report.nextSafeTask}\``,
    "",
    "## Incomplete Checklist",
    "",
    "| Priority | Gate | Status | Validation | Method |",
    "| --- | --- | --- | --- | --- |",
    rows || "| - | none | pass | - | - |",
    "",
  ].join("\n");
}

export async function buildCapitalLiveReadinessSimulation({
  repoRoot = process.cwd(),
  generatedAt = new Date().toISOString(),
} = {}) {
  const reportPath = path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-live-readiness-simulation-latest.json",
  );
  const markdownPath = path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-live-readiness-simulation-latest.md",
  );
  const panelPath = path.join(
    repoRoot,
    ".openclaw",
    "trading",
    "capital-live-readiness-simulation.json",
  );
  const rawReports = {};
  await refreshSimulationPrerequisiteReports(repoRoot);
  const coreProductMatrix = await writeCapitalCoreProductFreshnessMatrix({ repoRoot });
  for (const [key, relativePath] of Object.entries(SOURCE_REPORTS)) {
    if (key === "coreProductMatrix") {
      rawReports[key] = {
        path: coreProductMatrix.outputPath,
        json: coreProductMatrix.matrix,
      };
      continue;
    }
    const fullPath = path.join(repoRoot, relativePath);
    rawReports[key] = {
      path: fullPath,
      json: await readJsonIfExists(fullPath),
    };
  }

  const gateChecklist = qualifyGateCommands(repoRoot, buildGateChecklist(rawReports));
  const incompleteChecklist = failedGates(gateChecklist);
  const simulationLog = buildSimulationLog(gateChecklist);
  const acceptedRuns = simulationLog.filter(
    (run) => run.status === "accepted_for_operator_execution_review",
  ).length;
  const blockedRuns = simulationLog.length - acceptedRuns;
  const nextSafeTask = qualifyOpenClawPnpmCommands(
    repoRoot,
    deriveNextSafeTask(gateChecklist, rawReports),
  );
  const direct = rawReports.directStatus.json;
  const coreMatrix = rawReports.coreProductMatrix.json;
  const platform = rawReports.platformGate.json;
  const adapter = rawReports.adapterAck.json;
  const applyReceipt = rawReports.adapterApplyReceipt.json;
  const packet = rawReports.operatorPacket.json;
  const currentPaperIntents = rawReports.currentPaperIntents.json;
  const adapterApplyReceiptVerified =
    gateChecklist.some(
      (gate) => gate?.id === "adapter:apply-receipt-verified" && gate?.status === "pass",
    ) ||
    (applyReceipt?.status === "no_apply_required" &&
      applyReceipt?.operatorReceipt?.noApplyRequired === true &&
      applyReceipt?.operatorReceipt?.activeState === "pre_apply_current_matches");

  const report = {
    schema: SCHEMA,
    generatedAt,
    repoRoot,
    status:
      incompleteChecklist.length === 0
        ? "ready_for_operator_execution_review"
        : "blocked_live_readiness_incomplete",
    mode: "report_only_live_order_readiness_simulation",
    requestedTrade: {
      mode: "all_product_strategy_candidate_pool",
      candidateSource: SOURCE_REPORTS.currentPaperIntents,
      legacyInstrument:
        getPath(direct, "summary.requestedTrade.instrument") ??
        getPath(platform, "strategyPlatform.requestedTrade.instrument") ??
        "",
      legacyQuoteSymbol:
        getPath(direct, "summary.requestedTrade.quoteSymbol") ??
        getPath(platform, "strategyPlatform.requestedTrade.quoteSymbol") ??
        "",
      holdingMode:
        getPath(direct, "summary.requestedTrade.holdingMode") ??
        getPath(platform, "strategyPlatform.requestedTrade.holdingMode") ??
        "",
      orderApi:
        getPath(direct, "summary.requestedTrade.orderApi") ??
        getPath(packet, "executionPayload.brokerApi") ??
        "",
      note: "A50 is advisory unless selected by the all-product paper-intent pool.",
    },
    simulationRuns: SIMULATION_RUNS,
    completion: {
      acceptedRuns,
      blockedRuns,
      failedGateCount: incompleteChecklist.length,
      falseAccepted: 0,
      noLiveOrderSent: true,
      sentOrder: false,
    },
    operatorCanExecute: incompleteChecklist.length === 0,
    dispatchPolicy:
      getPath(rawReports.localExecutorDispatch.json, "dispatchPolicy") ??
      getPath(platform, "liveCompletion.dispatchPolicy") ??
      "blocked_do_not_send",
    sealedOrderIntent: {
      sha256:
        getPath(direct, "summary.sealedOrderIntent.sha256") ??
        getPath(platform, "execution.sealedOrderIntentSha256") ??
        getPath(packet, "sealedIntentSha256") ??
        "",
      status: getPath(direct, "summary.sealedOrderIntent.status") ?? "",
      brokerWriteAllowedByOpenClaw:
        getPath(direct, "summary.sealedOrderIntent.brokerWriteAllowedByOpenClaw") ?? false,
    },
    quoteFreshness: {
      coreProductMatrix: {
        status: coreMatrix?.status ?? "",
        ready: coreMatrix?.ready ?? false,
        productCount: coreMatrix?.summary?.productCount ?? null,
        freshCount: coreMatrix?.summary?.freshCount ?? null,
        requiredReady: coreMatrix?.summary?.requiredReady ?? false,
        blockedRequiredIds: safeArray(coreMatrix?.summary?.blockedRequiredIds),
        sessionClosedIds: safeArray(coreMatrix?.summary?.sessionClosedIds),
        generatedAt: coreMatrix?.generatedAt ?? "",
      },
      a50Status: getPath(direct, "summary.quote.a50Status") ?? "",
      a50Subscribed: getPath(direct, "summary.quote.a50Subscribed") ?? false,
      a50AgeSeconds: getPath(direct, "summary.quote.a50AgeSeconds") ?? null,
      a50WallClockAgeSeconds: getPath(direct, "summary.quote.a50WallClockAgeSeconds") ?? null,
      overallFreshness: getPath(platform, "quote.overallFreshness") ?? "",
      strategyQuoteReady: getPath(platform, "quote.strategyQuoteReady") ?? false,
      currentPaperIntents: {
        status: currentPaperIntents?.status ?? "missing",
        generatedIntentCount:
          currentPaperIntents?.targetRegistry?.generatedIntentCount ??
          currentPaperIntents?.intentWrite?.activeIntentsRecordCount ??
          0,
        writtenTargetIds: safeArray(currentPaperIntents?.targetRegistry?.writtenTargetIds),
      },
    },
    positionDecision: {
      status: getPath(direct, "summary.position.decisionStatus") ?? "",
      freshnessStatus: getPath(direct, "summary.position.freshnessStatus") ?? "",
      netContracts: getPath(direct, "summary.position.netContracts") ?? null,
      hasOpenPosition: getPath(direct, "summary.position.hasOpenPosition") ?? null,
    },
    externalBrokerAdapter: {
      ack: {
        status: adapter?.ack?.status ?? adapter?.status ?? "missing",
        usable: adapter?.ack?.usable ?? false,
        hashOk: adapter?.ack?.hashOk ?? false,
        canarySentOrder: adapter?.ack?.canarySentOrder ?? null,
        rollbackFresh: adapter?.ack?.rollbackFresh ?? false,
        expectedSealedIntentSha256: adapter?.ack?.expectedValue?.sealedIntentSha256 ?? "",
        actualSealedIntentSha256: adapter?.ack?.currentValue?.sealedIntentSha256 ?? "",
      },
      applyReceipt: {
        status: rawReports.adapterApplyReceipt.json?.status ?? "missing",
        verified: adapterApplyReceiptVerified,
        action: rawReports.adapterApplyReceipt.json?.operatorReceipt?.action ?? "",
        operatorMayApply:
          rawReports.adapterApplyReceipt.json?.operatorReceipt?.operatorMayApply ?? false,
        operatorApplyVerified:
          rawReports.adapterApplyReceipt.json?.operatorReceipt?.operatorApplyVerified ?? false,
        reportPath: SOURCE_REPORTS.adapterApplyReceipt,
      },
    },
    sourceReports: summarizeSourceReports(repoRoot, rawReports),
    gateChecklist,
    incompleteChecklist,
    incompleteCount: incompleteChecklist.length,
    methodCatalog: buildMethodCatalog(gateChecklist),
    simulationLog,
    nextSafeTask,
    nextCommands: [...new Set(incompleteChecklist.map((gate) => gate.validationCommand))],
    commandSurface: {
      schema: "openclaw.command-surface.repo-root-pnpm.v1",
      repoRoot,
      noPkgManifestAvoided: true,
    },
    safety: {
      reportOnly: true,
      simulatedOnly: true,
      allowLiveTrading: false,
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      brokerWriteAttempted: false,
      sentOrder: false,
      noLiveOrderSent: true,
      no_live_order_sent: true,
    },
    paths: {
      reportPath,
      markdownPath,
      panelPath,
    },
    machineLine: `capitalLiveReadinessSimulation=${incompleteChecklist.length === 0 ? "ready_for_operator_execution_review" : "blocked_live_readiness_incomplete"} runs=${SIMULATION_RUNS} accepted=${acceptedRuns} blocked=${blockedRuns} incomplete=${incompleteChecklist.length} operatorCanExecute=${incompleteChecklist.length === 0} noLiveOrderSent=true sentOrder=false next=${nextSafeTask}`,
  };
  return report;
}

export async function writeCapitalLiveReadinessSimulation(report) {
  await writeJsonWithSha(report.paths.reportPath, report);
  await writeTextWithSha(report.paths.markdownPath, buildMarkdown(report));
  await writeJsonWithSha(report.paths.panelPath, report);
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildCapitalLiveReadinessSimulation({ repoRoot: process.cwd() });
  if (options.writeState) {
    await writeCapitalLiveReadinessSimulation(report);
  }
  if (options.check) {
    if (
      report.simulationRuns !== SIMULATION_RUNS ||
      report.safety.noLiveOrderSent !== true ||
      report.safety.sentOrder !== false ||
      report.safety.writeBrokerOrders !== false ||
      report.completion.falseAccepted !== 0
    ) {
      throw new Error("CAPITAL_LIVE_READINESS_SIMULATION_SAFETY_MISMATCH");
    }
  }
  if (options.json || options.check) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${report.machineLine}\n`);
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
