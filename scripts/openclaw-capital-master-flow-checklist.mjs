import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";
import { readCapitalServiceStatus } from "./openclaw-capital-service-status.mjs";

const SCHEMA = "openclaw.capital.master-flow-checklist.v1";

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

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "EISDIR") {
      return "";
    }
    throw error;
  }
}

function hasAll(text, needles) {
  return needles.every((needle) => text.includes(needle));
}

async function buildPreTradeRiskWiringEvidence(capitalRoot) {
  const serviceText = await readTextIfExists(path.join(capitalRoot, "CapitalHftService.cs"));
  const checks = {
    ipcStockUsesHandler:
      serviceText.includes('case "send_stock_order":') &&
      serviceText.includes("HandleSendStockOrder(cmd);"),
    stockHandlerExists: serviceText.includes("private void HandleSendStockOrder(HftCommand cmd)"),
    strategyUsesHandler: serviceText.includes("HandleSendOsFutureOrder(cmd);"),
    checkRiskCallsGate: hasAll(serviceText, ["BuildRiskIntent(cmd)", "_riskGate.Check(intent)"]),
    gateCanAdjustQty: serviceText.includes("cmd.Qty = intent.Qty;"),
  };
  return {
    status: Object.values(checks).every(Boolean) ? "wired" : "incomplete",
    checks,
  };
}

function flowStatus(ok, partial = false) {
  if (ok) {
    return "completed";
  }
  return partial ? "partial" : "blocked";
}

function checkFileStatus(value) {
  return value ? "present" : "missing";
}

function statusIcon(status) {
  switch (status) {
    case "completed":
      return "OK";
    case "partial":
      return "PARTIAL";
    case "blocked":
      return "BLOCKED";
    case "not_started":
      return "TODO";
    default:
      return String(status || "UNKNOWN").toUpperCase();
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

const COMMAND_DISPLAY_ALIASES = [
  ["capital-hft:quote:reportable", "capital:quote:reportable"],
  ["capital-hft:quote:reportable:check", "capital:quote:reportable:check"],
  ["capital-hft:capital:master-flow-checklist", "capital:master-flow-checklist"],
  ["capital-hft:capital:master-flow-checklist:check", "capital:master-flow-checklist:check"],
  ["capital-hft:capital:completeness-report", "capital:completeness-report"],
  ["capital-hft:capital:completeness-report:check", "capital:completeness-report:check"],
  ["capital-hft:capital:full-chain", "capital:full-chain"],
  ["capital-hft:capital:full-chain:check", "capital:full-chain:check"],
  ["capital-hft:capital:simulated-live", "capital:simulated-live"],
  ["capital-hft:capital:simulated-live:check", "capital:simulated-live:check"],
  ["capital-hft:capital:simulation-diagnostics", "capital:simulation-diagnostics"],
  ["capital-hft:capital:simulation-diagnostics:check", "capital:simulation-diagnostics:check"],
  ["capital-hft:capital:simulation:1000", "capital:simulation:1000"],
  ["capital-hft:capital:simulation:1000:check", "capital:simulation:1000:check"],
  ["capital-hft:capital:live-order-dry-run", "capital:live-order-dry-run"],
  ["capital-hft:capital:live-order-dry-run:check", "capital:live-order-dry-run:check"],
  ["capital-hft:capital:latency-gap", "capital:latency-gap"],
  ["capital-hft:capital:latency-gap:check", "capital:latency-gap:check"],
  ["capital-hft:capital:overseas-rotation", "capital:overseas-rotation"],
  ["capital-hft:capital:overseas-rotation:check", "capital:overseas-rotation:check"],
  ["capital-hft:capital:walk-forward:qmd", "capital:walk-forward:qmd"],
  ["capital-hft:capital:walk-forward:qmd:check", "capital:walk-forward:qmd:check"],
  ["capital-hft:live-strategy:readiness", "capital:live-strategy:readiness"],
  ["capital-hft:live-strategy:readiness:check", "capital:live-strategy:readiness:check"],
  ["capital-hft:live-trading:approval:summary", "capital:live-trading:approval:summary"],
  [
    "capital-hft:live-trading:approval:summary:check",
    "capital:live-trading:approval:summary:check",
  ],
  ["capital-hft:live-trading:approval:sync", "capital:live-trading:approval:sync"],
  ["capital-hft:live-trading:approval:sync:check", "capital:live-trading:approval:sync:check"],
  ["capital-hft:live-trading:approval:check", "capital:live-trading:approval:check"],
  ["capital-hft:live-trading:human-approval", "capital:live-trading:human-approval"],
  ["capital-hft:live-trading:human-approval:check", "capital:live-trading:human-approval:check"],
  ["capital-hft:live-trading:promotion", "capital:live-trading:promotion"],
  ["capital-hft:live-trading:promotion:check", "capital:live-trading:promotion:check"],
  ["capital-hft:paper-loop", "capital:paper-loop"],
  ["capital-hft:paper-loop:check", "capital:paper-loop:check"],
  ["capital-hft:strategy:bar-accumulator", "capital:strategy:bar-accumulator"],
  ["capital-hft:strategy:bar-accumulator:json", "capital:strategy:bar-accumulator:json"],
  ["capital-hft:strategy:engine", "capital:strategy:engine"],
  ["capital-hft:strategy:engine:check", "capital:strategy:engine:check"],
  ["capital-hft:strategy:engine:json", "capital:strategy:engine:json"],
  ["capital-hft:strategy:fill-simulation", "capital:strategy:fill-simulation"],
  ["capital-hft:strategy:fill-simulation:json", "capital:strategy:fill-simulation:json"],
].sort((a, b) => b[0].length - a[0].length);

function preferCapitalCommand(value) {
  if (typeof value !== "string") {
    return value;
  }
  let next = value;
  for (const [legacy, preferred] of COMMAND_DISPLAY_ALIASES) {
    next = next.replaceAll(legacy, preferred);
  }
  return next;
}

function preferCapitalFlowCommands(flows) {
  return flows.map((flow) => ({ ...flow, command: preferCapitalCommand(flow.command) }));
}

function preferCapitalProductionPlan(plan) {
  return plan.map((item) => ({ ...item, command: preferCapitalCommand(item.command) }));
}

function categoryCount(value) {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (typeof value === "number") {
    return value;
  }
  return 0;
}

function categorySample(value, limit = 3) {
  if (!Array.isArray(value) || value.length === 0) {
    return "";
  }
  const paths = value
    .slice(0, limit)
    .map((item) => item?.path || item?.target || item?.name || "")
    .filter(Boolean);
  return paths.length > 0 ? ` sample=${paths.join(";")}` : "";
}

function buildFlows({
  rootOk,
  service,
  serviceRuntime,
  callback,
  strategy,
  fill,
  simulation,
  fullChain,
  simulationDiagnostics,
  simulatedLive,
  liveOrderDryRunPretrade,
  telegramSimulatedLive,
  telegramSemiApproval,
  telegramSemiCallback,
  humanApproval,
  telegramHumanApproval,
  telegramHumanCallback,
  latencyGapInstrumentation,
  overseasRotation,
  walkForward,
  readiness,
  approval,
  mergeMap,
  packageScripts,
}) {
  const liveBlockers = Array.isArray(readiness?.livePromotion?.blockers)
    ? readiness.livePromotion.blockers
    : [];
  const requiresAdapter = mergeMap?.categories?.requires_adapter;
  const blockedRuntime = mergeMap?.categories?.blocked_runtime;
  const doNotMerge = mergeMap?.categories?.do_not_merge;
  const serviceLivenessStatus = serviceRuntime?.service?.livenessStatus || "missing";
  const servicePidAlive = serviceRuntime?.service?.pidAlive === true;
  const serviceStatusFresh = serviceRuntime?.service?.statusFresh === true;
  const serviceRuntimeReady =
    serviceRuntime?.ready === true &&
    servicePidAlive &&
    serviceStatusFresh &&
    serviceLivenessStatus === "alive";
  const serviceLoginReady =
    serviceRuntimeReady && service?.status === "running" && service?.loginStatus === "connected";
  return [
    {
      id: "root",
      name: "OpenClaw 根目錄與工作邊界",
      status: flowStatus(rootOk),
      evidence: rootOk
        ? "D:\\OpenClaw root markers present."
        : "Missing package/workspace root markers.",
      command: "pwd; git rev-parse --show-toplevel",
    },
    {
      id: "service-login",
      name: "群益登入與 SKCOM 服務",
      status: flowStatus(serviceLoginReady),
      evidence: `status=${service?.status || "missing"}, login=${service?.loginStatus || "missing"}, method=${service?.loginMethod || ""}, liveness=${serviceLivenessStatus}, pidAlive=${servicePidAlive}, statusFresh=${serviceStatusFresh}`,
      command: "pnpm capital:service-status:check",
    },
    {
      id: "live-callback-quotes",
      name: "國內/海外真實 callback 報價",
      status: flowStatus(
        service?.quoteMonitorConnected === true &&
          service?.osQuoteConnected === true &&
          Number(callback?.summary?.freshMatchedCount ?? 0) > 0,
      ),
      evidence: `domestic=${service?.quoteMonitorConnected === true}, overseas=${service?.osQuoteConnected === true}, freshMatched=${callback?.summary?.freshMatchedCount ?? 0}, stale=${(callback?.summary?.staleSymbols || []).join(",") || "none"}`,
      command: "pnpm capital-hft:quote:reportable:check",
    },
    {
      id: "quote-policy",
      name: "fresh + matched-only 報價政策",
      status: flowStatus(callback?.quoteFreshAllowed === true, true),
      evidence: `quoteFreshAllowed=${callback?.quoteFreshAllowed === true}, sourcePolicy=${callback?.sourcePolicy?.mode || "missing"}`,
      command:
        "node D:\\群益及元大API\\CapitalHftService\\openclaw-capital-callback-readback.mjs --json",
    },
    {
      id: "symbol-resolver",
      name: "商品 resolver / 台指近實際回流代號",
      status: flowStatus(strategy?.resolver?.ok === true),
      evidence: `requested=${strategy?.resolver?.requestedSymbol || ""}, resolved=${strategy?.resolver?.resolvedSymbol || ""}, status=${strategy?.resolver?.status || ""}`,
      command: "pnpm capital-hft:strategy:engine:check",
    },
    {
      id: "bar-and-strategy",
      name: "真實 callback -> K棒 -> ORB/EMA/VWAP paper strategy",
      status: flowStatus(
        strategy?.source?.liveCallbackSource === true &&
          Number(strategy?.stats?.signalsGenerated ?? 0) >= 0,
      ),
      evidence: `liveCallbackSource=${strategy?.source?.liveCallbackSource === true}, ticks=${strategy?.stats?.totalTicks ?? 0}, bars=${strategy?.stats?.barsBuilt ?? 0}, signals=${strategy?.stats?.signalsGenerated ?? 0}`,
      command: "pnpm capital-hft:strategy:engine:json",
    },
    {
      id: "paper-fill",
      name: "paper intent / fill simulation",
      status: flowStatus(fill?.status === "ok"),
      evidence: `status=${fill?.status || "missing"}, recommendation=${fill?.recommendation || ""}, intents=${fill?.stats?.total_intents ?? 0}`,
      command: "pnpm capital-hft:strategy:fill-simulation:json",
    },
    {
      id: "thousand-run-simulation",
      name: "1000 次 paper 策略壓力模擬",
      status: flowStatus(
        simulation?.schema === "openclaw.capital.thousand-run-simulation.v1" &&
          Number(simulation?.summary?.runs ?? 0) === 1000 &&
          simulation?.safety?.liveTradingEnabled === false &&
          simulation?.safety?.writeBrokerOrders === false &&
          simulation?.safety?.orderModeDryrunPass === true,
        simulation?.schema === "openclaw.capital.thousand-run-simulation.v1",
      ),
      evidence: `runs=${simulation?.summary?.runs ?? 0}, recommendation=${simulation?.recommendation || "missing"}, fixes=${simulation?.findings?.fixNow?.length ?? 0}, features=${simulation?.findings?.addFeatures?.length ?? 0}`,
      command: "pnpm capital-hft:capital:simulation:1000:check",
    },
    {
      id: "full-chain-simulation",
      name: "報價/查詢/下單/回報全鏈路 dry-run + 故障注入",
      status: flowStatus(
        fullChain?.schema === "openclaw.capital.full-chain-simulation-gate.v1" &&
          fullChain?.status === "passed" &&
          Number(fullChain?.summary?.runs ?? 0) >= 1000 &&
          Number(fullChain?.summary?.stageFailedCount ?? 1) === 0 &&
          Number(fullChain?.summary?.faultFailedCount ?? 1) === 0 &&
          fullChain?.safety?.noLiveOrderSent === true,
        fullChain?.schema === "openclaw.capital.full-chain-simulation-gate.v1",
      ),
      evidence: `runs=${fullChain?.summary?.runs ?? 0}, stageFailed=${fullChain?.summary?.stageFailedCount ?? "missing"}, faultFailed=${fullChain?.summary?.faultFailedCount ?? "missing"}, liveOrderNotProven=${fullChain?.liveRealismBoundary?.liveOrderNotProven === true}`,
      command: "pnpm capital-hft:capital:full-chain:check",
    },
    {
      id: "simulation-diagnostics",
      name: "模擬錯誤/阻擋/強化診斷",
      status: flowStatus(
        simulationDiagnostics?.schema === "openclaw.capital.simulation-diagnostics.v1" &&
          simulationDiagnostics?.status === "simulation_clean_live_blocked" &&
          simulationDiagnostics?.summary?.runtimeErrorCount === 0 &&
          simulationDiagnostics?.safety?.sentOrder === false,
        simulationDiagnostics?.schema === "openclaw.capital.simulation-diagnostics.v1",
      ),
      evidence: `status=${simulationDiagnostics?.status || "missing"}, runtimeErrors=${simulationDiagnostics?.summary?.runtimeErrorCount ?? "missing"}, blockers=${simulationDiagnostics?.summary?.hardBlockerCount ?? "missing"}, optimizations=${simulationDiagnostics?.summary?.optimizationCount ?? "missing"}`,
      command: "pnpm capital-hft:capital:simulation-diagnostics:check",
    },
    {
      id: "simulated-live-order-mode",
      name: "模擬真單 paper-only lane",
      status: flowStatus(
        simulatedLive?.schema === "openclaw.capital.simulated-live-order-mode.v1" &&
          simulatedLive?.status === "enabled_simulated_live" &&
          simulatedLive?.mode === "simulated_live_paper_only" &&
          simulatedLive?.safety?.sentOrder === false &&
          simulatedLive?.safety?.writeBrokerOrders === false &&
          simulatedLive?.simulatedOrder?.routingDecision === "paper-simulated",
        simulatedLive?.schema === "openclaw.capital.simulated-live-order-mode.v1",
      ),
      evidence: `status=${simulatedLive?.status || "missing"}, routing=${simulatedLive?.simulatedOrder?.routingDecision || "missing"}, api=${simulatedLive?.simulatedOrder?.wouldUseBrokerApi || "missing"}, sentOrder=${simulatedLive?.safety?.sentOrder ?? "missing"}`,
      command: "pnpm capital-hft:capital:simulated-live:check",
    },
    {
      id: "live-order-dry-run-pretrade-gate",
      name: "真單格式 dry-run PreTradeRiskGate",
      status: flowStatus(
        liveOrderDryRunPretrade?.schema ===
          "openclaw.capital.live-order-dry-run-pretrade-gate.v1" &&
          liveOrderDryRunPretrade?.status === "live_order_dry_run_pretrade_blocked" &&
          liveOrderDryRunPretrade?.preTradeRiskGate?.attachedBeforeBrokerSend === true &&
          liveOrderDryRunPretrade?.preTradeRiskGate?.evaluated === true &&
          liveOrderDryRunPretrade?.preTradeRiskGate?.allowedToSend === false &&
          liveOrderDryRunPretrade?.safety?.sentOrder === false &&
          liveOrderDryRunPretrade?.safety?.quarantineOnly === true,
        liveOrderDryRunPretrade?.schema === "openclaw.capital.live-order-dry-run-pretrade-gate.v1",
      ),
      evidence: `status=${liveOrderDryRunPretrade?.status || "missing"}, api=${liveOrderDryRunPretrade?.liveOrderDraft?.brokerApi || "missing"}, allowedToSend=${liveOrderDryRunPretrade?.preTradeRiskGate?.allowedToSend ?? "missing"}, sentOrder=${liveOrderDryRunPretrade?.safety?.sentOrder ?? "missing"}, blockers=${liveOrderDryRunPretrade?.preTradeRiskGate?.blockerCount ?? "missing"}`,
      command: "pnpm capital-hft:capital:live-order-dry-run:check",
    },
    {
      id: "telegram-simulated-live-order",
      name: "Telegram 模擬真單入口",
      status: flowStatus(
        telegramSimulatedLive?.schema === "openclaw.capital.telegram-simulated-live-order.v1" &&
          telegramSimulatedLive?.status === "telegram_simulated_live_ready" &&
          telegramSimulatedLive?.safety?.telegramDryRunOnly === true &&
          telegramSimulatedLive?.safety?.sentOrder === false &&
          telegramSimulatedLive?.simulatedLive?.routingDecision === "paper-simulated",
        telegramSimulatedLive?.schema === "openclaw.capital.telegram-simulated-live-order.v1",
      ),
      evidence: `status=${telegramSimulatedLive?.status || "missing"}, route=${telegramSimulatedLive?.simulatedLive?.routingDecision || "missing"}, sentOrder=${telegramSimulatedLive?.safety?.sentOrder ?? "missing"}, telegramMessageSent=${telegramSimulatedLive?.safety?.telegramMessageSent ?? "missing"}`,
      command: "pnpm capital:telegram:simulated-live:check",
    },
    {
      id: "telegram-semi-approval-gate",
      name: "Telegram SEMI 人工確認 gate",
      status: flowStatus(
        telegramSemiApproval?.schema === "openclaw.capital.telegram-semi-approval-gate.v1" &&
          telegramSemiApproval?.status === "semi_approval_pending_live_blocked" &&
          telegramSemiApproval?.safety?.telegramDryRunOnly === true &&
          telegramSemiApproval?.safety?.sentOrder === false &&
          telegramSemiApproval?.promotionGate?.status === "blocked",
        telegramSemiApproval?.schema === "openclaw.capital.telegram-semi-approval-gate.v1",
      ),
      evidence: `status=${telegramSemiApproval?.status || "missing"}, buttons=${telegramSemiApproval?.telegramUi?.buttons?.length ?? 0}, sentOrder=${telegramSemiApproval?.safety?.sentOrder ?? "missing"}, promotion=${telegramSemiApproval?.promotionGate?.status || "missing"}`,
      command: "pnpm capital:telegram:semi-approval:check",
    },
    {
      id: "telegram-semi-callback-handler",
      name: "Telegram SEMI callback reviewChecklist 寫入",
      status: flowStatus(
        telegramSemiCallback?.schema === "openclaw.capital.telegram-semi-approval-callback.v1" &&
          ["callback_review_checklist_ready", "callback_review_checklist_written"].includes(
            telegramSemiCallback?.status,
          ) &&
          telegramSemiCallback?.callback?.matched === true &&
          telegramSemiCallback?.safety?.sentOrder === false &&
          telegramSemiCallback?.safety?.doesNotSetHumanApproved === true &&
          telegramSemiCallback?.promotionGate?.status === "blocked",
        telegramSemiCallback?.schema === "openclaw.capital.telegram-semi-approval-callback.v1",
      ),
      evidence: `status=${telegramSemiCallback?.status || "missing"}, action=${telegramSemiCallback?.callback?.button?.action || "missing"}, applied=${telegramSemiCallback?.approvalWrite?.applied ?? "missing"}, productionWrite=${telegramSemiCallback?.approvalWrite?.writesProductionApprovalFile ?? "missing"}, sentOrder=${telegramSemiCallback?.safety?.sentOrder ?? "missing"}`,
      command: "pnpm capital:telegram:semi-callback:check",
    },
    {
      id: "qmd-walk-forward",
      name: "QMD walk-forward 歷史樣本外回放",
      status: flowStatus(
        walkForward?.schema === "openclaw.capital.qmd-walk-forward-gate.v1" &&
          walkForward?.status === "passed" &&
          walkForward?.safety?.liveTradingEnabled === false &&
          walkForward?.safety?.writeBrokerOrders === false,
        walkForward?.schema === "openclaw.capital.qmd-walk-forward-gate.v1",
      ),
      evidence: `status=${walkForward?.status || "missing"}, trades=${walkForward?.summary?.totalTestTrades ?? 0}, positiveFoldRate=${walkForward?.summary?.positiveFoldRate ?? 0}, pnl=${walkForward?.summary?.totalTestPnlPts ?? 0}`,
      command: "pnpm capital-hft:capital:walk-forward:qmd:check",
    },
    {
      id: "paper-loop",
      name: "紙上自動化 loop / controlled readiness",
      status: flowStatus(readiness?.capabilities?.paperStrategyExecution === true),
      evidence: `paperStrategyExecution=${readiness?.capabilities?.paperStrategyExecution === true}, status=${readiness?.status || ""}`,
      command: "pnpm capital-hft:paper-loop:check",
    },
    {
      id: "telegram-control",
      name: "Telegram 查價/狀態入口",
      status: flowStatus(
        packageScripts.has("capital:telegram:quote-natural-reply:check") &&
          service?.telegram?.pollingOwner === "openclaw_gateway",
        packageScripts.has("capital:telegram:quote-natural-reply:check"),
      ),
      evidence: `owner=${service?.telegram?.pollingOwner || ""}, duplicatePoller=${service?.telegram?.duplicatePollerDetected === true}`,
      command: "pnpm capital:telegram:quote-natural-reply:check",
    },
    {
      id: "account-position-reply",
      name: "帳戶/倉位/回報讀取",
      status: flowStatus(
        Array.isArray(service?.accounts) &&
          service.accounts.length > 0 &&
          service?.orderInitialized === true,
        true,
      ),
      evidence: `accounts=${service?.accounts?.length ?? 0}, orderInitialized=${service?.orderInitialized === true}, sentOrders=${service?.orderStats?.sent ?? 0}`,
      command: "pnpm capital:service-status:check",
    },
    {
      id: "human-approval-unit",
      name: "真單人工核准單位",
      status: flowStatus(
        humanApproval?.schema === "openclaw.capital.live-trading-human-approval-request.v1" &&
          humanApproval?.status === "pending_manual_human_approval" &&
          humanApproval?.safety?.liveTradingEnabled === false &&
          humanApproval?.safety?.writeBrokerOrders === false &&
          humanApproval?.safety?.sentOrder === false,
        humanApproval?.schema === "openclaw.capital.live-trading-human-approval-request.v1",
      ),
      evidence: `status=${humanApproval?.status || "missing"}, accounts=${humanApproval?.accountAllowlist?.length ?? 0}, token=${humanApproval?.approvalToken ? "present" : "missing"}, sentOrder=${humanApproval?.safety?.sentOrder ?? "missing"}`,
      command: "pnpm capital-hft:live-trading:human-approval:check",
    },
    {
      id: "telegram-human-approval",
      name: "Telegram 真單人工核准入口",
      status: flowStatus(
        telegramHumanApproval?.schema === "openclaw.capital.telegram-human-approval.v1" &&
          telegramHumanApproval?.status === "telegram_human_approval_ready" &&
          telegramHumanApproval?.safety?.sentOrder === false &&
          telegramHumanApproval?.callbackContract?.enablesLiveTrading === false,
        telegramHumanApproval?.schema === "openclaw.capital.telegram-human-approval.v1",
      ),
      evidence: `status=${telegramHumanApproval?.status || "missing"}, buttons=${telegramHumanApproval?.telegramUi?.buttons?.length ?? 0}, sentOrder=${telegramHumanApproval?.safety?.sentOrder ?? "missing"}`,
      command: "pnpm capital:telegram:human-approval:check",
    },
    {
      id: "telegram-human-approval-callback",
      name: "Telegram 真單人工核准 callback",
      status: flowStatus(
        telegramHumanCallback?.schema === "openclaw.capital.telegram-human-approval-callback.v1" &&
          telegramHumanCallback?.status === "telegram_human_approval_callback_ready" &&
          telegramHumanCallback?.safety?.sentOrder === false &&
          telegramHumanCallback?.safety?.doesNotEnableLiveTrading === true &&
          telegramHumanCallback?.scope?.productionApprovalWrite === false,
        telegramHumanCallback?.schema === "openclaw.capital.telegram-human-approval-callback.v1",
      ),
      evidence: `status=${telegramHumanCallback?.status || "missing"}, applied=${telegramHumanCallback?.approvalResult?.applied ?? "missing"}, productionWrite=${telegramHumanCallback?.scope?.productionApprovalWrite ?? "missing"}, sentOrder=${telegramHumanCallback?.safety?.sentOrder ?? "missing"}`,
      command: "pnpm capital:telegram:human-callback:check",
    },
    {
      id: "latency-gap-instrumentation",
      name: "LatencyMonitor / GapDetector tick -> signal -> order instrumentation",
      status: flowStatus(
        latencyGapInstrumentation?.schema === "openclaw.capital.latency-gap-instrumentation.v1" &&
          latencyGapInstrumentation?.status === "passed" &&
          latencyGapInstrumentation?.safety?.liveTradingEnabled === false &&
          latencyGapInstrumentation?.safety?.writeBrokerOrders === false,
        latencyGapInstrumentation?.schema === "openclaw.capital.latency-gap-instrumentation.v1",
      ),
      evidence: `status=${latencyGapInstrumentation?.status || "missing"}, tickToSignal=${latencyGapInstrumentation?.staticEvidence?.counts?.tickToSignalRecordCalls ?? "missing"}, orderRoundTrip=${latencyGapInstrumentation?.staticEvidence?.counts?.orderRoundTripRecordCalls ?? "missing"}, sentOrder=${latencyGapInstrumentation?.safety?.sentOrder ?? "missing"}`,
      command: "pnpm capital-hft:capital:latency-gap:check",
    },
    {
      id: "overseas-product-rotation",
      name: "Overseas product rotation beyond 64 SKOS slots",
      status: flowStatus(
        overseasRotation?.schema === "openclaw.capital.overseas-product-rotation.v1" &&
          overseasRotation?.status === "passed" &&
          overseasRotation?.constraints?.maxSkosPageSize === 64 &&
          overseasRotation?.summary?.pageCount > 1 &&
          overseasRotation?.summary?.maxPageSize <= 64 &&
          overseasRotation?.safety?.liveTradingEnabled === false &&
          overseasRotation?.safety?.writeBrokerOrders === false,
        overseasRotation?.schema === "openclaw.capital.overseas-product-rotation.v1",
      ),
      evidence: `status=${overseasRotation?.status || "missing"}, products=${overseasRotation?.summary?.productCount ?? "missing"}, pages=${overseasRotation?.summary?.pageCount ?? "missing"}, activePage=${overseasRotation?.activePage?.size ?? "missing"}, maxPage=${overseasRotation?.summary?.maxPageSize ?? "missing"}`,
      command: "pnpm capital-hft:capital:overseas-rotation:check",
    },
    {
      id: "live-promotion",
      name: "真單 promotion / broker write gate",
      status: readiness?.capabilities?.liveTradingExecution === true ? "completed" : "blocked",
      evidence: `liveTradingExecution=${readiness?.capabilities?.liveTradingExecution === true}, brokerWrite=${readiness?.capabilities?.brokerWriteExecution === true}, blockers=${liveBlockers.join(",")}`,
      command: "pnpm capital-hft:live-trading:promotion:check",
    },
    {
      id: "claude-fusion",
      name: "Claude angry-bohr 差異融合",
      status: categoryCount(requiresAdapter) === 0 ? "completed" : "partial",
      evidence: `requires_adapter=${categoryCount(requiresAdapter)}, blocked_runtime=${categoryCount(blockedRuntime)}, do_not_merge=${categoryCount(doNotMerge)}${categorySample(requiresAdapter)}`,
      command: "pnpm capital:angry-bohr:merge-map:check",
    },
  ];
}

function buildActionableUnfinished({
  completeness,
  walkForward,
  telegramSemiApproval,
  preTradeRiskWiring,
  latencyGapInstrumentation,
  overseasRotation,
}) {
  const telegramSemiGatePresent =
    telegramSemiApproval?.schema === "openclaw.capital.telegram-semi-approval-gate.v1" &&
    telegramSemiApproval?.status === "semi_approval_pending_live_blocked";
  const preTradeRiskWired = preTradeRiskWiring?.status === "wired";
  const latencyGapPassed =
    latencyGapInstrumentation?.schema === "openclaw.capital.latency-gap-instrumentation.v1" &&
    latencyGapInstrumentation?.status === "passed";
  const overseasRotationPassed =
    overseasRotation?.schema === "openclaw.capital.overseas-product-rotation.v1" &&
    overseasRotation?.status === "passed";
  const fromCompleteness = Array.isArray(completeness?.unfinished)
    ? completeness.unfinished
        .filter((item) => {
          const text = String(item.item);
          if (/live approval|angry-bohr|callback readback stale/u.test(text)) {
            return false;
          }
          if (preTradeRiskWired && /PreTradeRiskGate/u.test(text)) {
            return false;
          }
          if (telegramSemiGatePresent && /SEMI approval/u.test(text)) {
            return false;
          }
          if (latencyGapPassed && /LatencyMonitor|GapDetector/u.test(text)) {
            return false;
          }
          if (overseasRotationPassed && /Overseas product rotation|64 SKOS/u.test(text)) {
            return false;
          }
          return true;
        })
        .map((item) => ({
          item: item.item,
          reason: item.reason,
          impact: item.impact,
          source: "completeness-report",
        }))
    : [];
  const walkForwardPassed =
    walkForward?.schema === "openclaw.capital.qmd-walk-forward-gate.v1" &&
    walkForward?.status === "passed";
  const knownMissing = [
    preTradeRiskWired
      ? null
      : {
          item: "PreTradeRiskGate before every broker send path",
          reason: "必須固定在送單前阻擋風險，而不是只存在 class。",
          impact: "未完成前真單不可開啟。",
          source: "master-checklist",
        },
    telegramSemiGatePresent
      ? null
      : {
          item: "SEMI approval blocking before order intent execution",
          reason: "SEMI 模式必須真的等待人工確認，不可等同 AUTO。",
          impact: "未完成前真單不可開啟。",
          source: "master-checklist",
        },
    latencyGapPassed
      ? null
      : {
          item: "LatencyMonitor / GapDetector tick -> signal -> order instrumentation",
          reason: "需要證明 HFT 流程延遲與跳空風險。",
          impact: "未完成前不能宣稱高頻策略安全可真單。",
          source: "master-checklist",
        },
    walkForwardPassed
      ? null
      : {
          item: "Walk-forward / QMD historical replay gate",
          reason: "paper fill simulation 仍需歷史資料回放與樣本外驗證補強。",
          impact: "策略可模擬，但不能只靠單一即時片段升真單。",
          source: "master-checklist",
        },
    overseasRotationPassed
      ? null
      : {
          item: "Overseas product rotation beyond 64 SKOS slots",
          reason: "群益海外訂閱存在每批限制；全商品需排程輪詢/分頁。",
          impact: "已有核心海外商品，不等於 1252 全商品同時 fresh。",
          source: "master-checklist",
        },
  ].filter(Boolean);
  return dedupeItems([...knownMissing, ...fromCompleteness]);
}

function buildOperationalBlockers({ readiness, approval, callback, serviceRuntime }) {
  const serviceLivenessStatus = serviceRuntime?.service?.livenessStatus || "missing";
  const serviceItems =
    serviceRuntime?.ready === true
      ? []
      : [
          {
            item: `CapitalHftService runtime: ${serviceLivenessStatus}`,
            reason: "服務 PID 或狀態新鮮度未通過 capital:service-status:check。",
            impact: "報價、查詢、回報、下單流程只能維持 blocked/paper-only，不可宣稱即時鏈路完成。",
            source: "capital-service-status",
          },
        ];
  const liveBlockers = Array.isArray(readiness?.livePromotion?.blockers)
    ? readiness.livePromotion.blockers.map((blocker) => ({
        item: blocker,
        reason: "live promotion gate 仍阻擋真單。",
        impact: "未解除前只能 paper/simulation，不能送真單。",
        source: "live-readiness",
      }))
    : [];
  const staleSymbols = Array.isArray(callback?.summary?.staleSymbols)
    ? callback.summary.staleSymbols.map((symbol) => ({
        item: `stale callback symbol: ${symbol}`,
        reason: "目前不是 fresh matched callback。",
        impact: "運行時阻擋；不能列為要製作的新功能，也不能回舊價。",
        source: "callback-readback",
      }))
    : [];
  const approvalItems = [
    approval?.humanApproved === true
      ? null
      : {
          item: "live approval: humanApproved=false",
          reason: "缺人工批准。",
          impact: "真單不可開啟。",
          source: "capital-live-trading-approval",
        },
    Array.isArray(approval?.accountAllowlist) && approval.accountAllowlist.length > 0
      ? null
      : {
          item: "live approval: accountAllowlist empty",
          reason: "未指定允許下單帳號。",
          impact: "真單不可開啟。",
          source: "capital-live-trading-approval",
        },
    approval?.killSwitch === true
      ? null
      : {
          item: "live approval: killSwitch not armed",
          reason: "缺緊急停止/回滾條件。",
          impact: "真單不可開啟。",
          source: "capital-live-trading-approval",
        },
    typeof approval?.rollbackPlan === "string" && approval.rollbackPlan.trim()
      ? null
      : {
          item: "live approval: rollbackPlan empty",
          reason: "缺回滾方案。",
          impact: "真單不可開啟。",
          source: "capital-live-trading-approval",
        },
  ].filter(Boolean);
  return dedupeItems([...serviceItems, ...liveBlockers, ...approvalItems, ...staleSymbols]);
}

function buildExcludedItems({ mergeMap }) {
  const requiresAdapter = mergeMap?.categories?.requires_adapter;
  const requiresAdapterCount = categoryCount(requiresAdapter);
  const blockedRuntime = mergeMap?.categories?.blocked_runtime;
  const doNotMerge = mergeMap?.categories?.do_not_merge;
  return [
    {
      item: "stale/old quote fallback",
      reason: "只允許 fresh + matched callback；舊價、錯商品、0 價都不能拿來補。",
      decision: "exclude_from_build_plan",
      source: "quote-policy",
    },
    {
      item: "angry-bohr blocked_runtime direct merge",
      reason: `${categoryCount(blockedRuntime)} runtime/live/write paths are not safe for wholesale merge.${categorySample(blockedRuntime)}`,
      decision: "exclude_direct_merge",
      source: "merge-map",
    },
    {
      item: "angry-bohr do_not_merge direct merge",
      reason: `${categoryCount(doNotMerge)} paths are explicitly marked do_not_merge.${categorySample(doNotMerge)}`,
      decision: "exclude_direct_merge",
      source: "merge-map",
    },
    {
      item: "angry-bohr requires_adapter wholesale merge",
      reason: `${requiresAdapterCount} paths may be useful only after adapter conversion.${categorySample(requiresAdapter)}`,
      decision: "adapter_backlog_only",
      source: "merge-map",
    },
  ];
}

function buildLiveOrderScope({ service, readiness }) {
  const orderInitialized = service?.orderInitialized === true;
  const certificateLoaded = service?.certificateLoaded === true;
  const liveWriteEnabled = readiness?.capabilities?.brokerWriteExecution === true;
  const baseStatus =
    orderInitialized && certificateLoaded ? "paper_verified_live_blocked" : "blocked";
  const liveStatus = liveWriteEnabled ? "live_enabled" : baseStatus;
  return [
    {
      id: "domestic-day-trade",
      name: "國內期貨當沖單",
      status: liveStatus,
      evidence: "dayTradeMode=day_trade -> FUTUREORDER.sDayTrade=1；目前只允許 paper/dry-run。",
      blocker: liveWriteEnabled ? "" : "broker write disabled",
    },
    {
      id: "domestic-overnight",
      name: "國內期貨非當沖/留倉單",
      status: liveStatus,
      evidence: "dayTradeMode=overnight -> FUTUREORDER.sDayTrade=0；目前只允許 paper/dry-run。",
      blocker: liveWriteEnabled ? "" : "broker write disabled",
    },
    {
      id: "overseas-day-trade",
      name: "海外期貨當沖單",
      status: liveStatus,
      evidence:
        "dayTradeMode=day_trade -> OVERSEAFUTUREORDER.sDayTrade=1；目前只允許 paper/dry-run。",
      blocker: liveWriteEnabled ? "" : "broker write disabled",
    },
    {
      id: "overseas-overnight",
      name: "海外期貨非當沖/留倉單",
      status: liveStatus,
      evidence:
        "dayTradeMode=overnight -> OVERSEAFUTUREORDER.sDayTrade=0；目前只允許 paper/dry-run。",
      blocker: liveWriteEnabled ? "" : "broker write disabled",
    },
    {
      id: "broker-reply-and-position",
      name: "下單回報/帳戶/倉位查詢",
      status:
        Array.isArray(service?.accounts) && service.accounts.length > 0
          ? "connected_read_ready"
          : "blocked",
      evidence: `accounts=${service?.accounts?.length ?? 0}, orderInitialized=${orderInitialized}, sentOrders=${service?.orderStats?.sent ?? 0}`,
      blocker: "真單送出仍需 promotion gate",
    },
  ];
}

function dedupeItems(combined) {
  const seen = new Set();
  return combined.filter((item) => {
    const key = item.item;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildProductionPlan() {
  return [
    {
      phase: "P0",
      name: "固定查驗入口",
      goal: "每次先用同一份 checklist 看完成/未完成，不再一件一件猜。",
      command: "pnpm capital-hft:capital:master-flow-checklist:check",
    },
    {
      phase: "P1",
      name: "報價真實性與商品 resolver",
      goal: "所有策略只讀 fresh+matched callback；台指近用 tx-front resolver。",
      command: "pnpm capital-hft:quote:reportable:check && pnpm capital-hft:strategy:engine:check",
    },
    {
      phase: "P2",
      name: "紙上策略閉環",
      goal: "callback tick -> K棒 -> 策略 -> paper intent -> fill simulation -> auto review。",
      command:
        "pnpm capital-hft:strategy:engine:json && pnpm capital-hft:strategy:fill-simulation:json && pnpm capital-hft:paper-loop:check",
    },
    {
      phase: "P2.5",
      name: "1000 次壓力模擬 + Telegram 模擬真單 + QMD walk-forward gate",
      goal: "先做 deterministic stress sweep，再開 paper-only 模擬真單 lane 與 Telegram 入口模擬，最後用 QMD 歷史資料做樣本外回放；未通過前不升真單。",
      command:
        "pnpm capital-hft:capital:simulation:1000:check && pnpm capital-hft:capital:full-chain:check && pnpm capital-hft:capital:simulation-diagnostics:check && pnpm capital-hft:capital:simulated-live:check && pnpm capital-hft:capital:live-order-dry-run:check && pnpm capital:telegram:simulated-live:check && pnpm capital:telegram:semi-approval:check && pnpm capital:telegram:semi-callback:check && pnpm capital-hft:capital:walk-forward:qmd:check",
    },
    {
      phase: "P3",
      name: "送單前固定風控鏈",
      goal: "PreTradeRiskGate -> SEMI approval -> latency/gap -> broker adapter，順序固定且可測。",
      command:
        "pnpm capital-hft:capital:live-order-dry-run:check && pnpm capital:telegram:semi-approval:check && pnpm capital:telegram:semi-callback:check && pnpm capital-hft:live-strategy:readiness:check && pnpm capital-hft:live-trading:promotion:check",
    },
    {
      phase: "P4",
      name: "多商品/海外輪詢",
      goal: "核心商品先穩定；全海外商品用 64-slot 分批與 reportable cache。",
      command: "pnpm capital-hft:quote:reportable:check",
    },
    {
      phase: "P5",
      name: "真單人工解鎖",
      goal: "只有人工核准、帳號白名單、kill switch、rollback、前置風控全 pass 才能解除。",
      command:
        "pnpm capital-hft:live-trading:human-approval:check && pnpm capital:telegram:human-approval:check && pnpm capital:telegram:human-callback:check && pnpm capital-hft:live-trading:approval:sync:check && pnpm capital-hft:live-trading:approval:check && pnpm capital-hft:live-trading:promotion:check",
    },
  ];
}

function toMarkdown(report) {
  const flowRows = report.flows.map(
    (flow) =>
      `| ${flow.id} | ${statusIcon(flow.status)} | ${flow.name} | ${flow.evidence.replace(/\|/gu, "/")} | \`${flow.command}\` |`,
  );
  const unfinishedRows = report.unfinished.map(
    (item, index) =>
      `| ${index + 1} | ${item.item.replace(/\|/gu, "/")} | ${item.reason.replace(/\|/gu, "/")} | ${item.impact.replace(/\|/gu, "/")} | ${item.source} |`,
  );
  const liveOrderRows = report.liveOrderScope.map(
    (item) =>
      `| ${item.id} | ${item.name} | ${item.status} | ${item.evidence.replace(/\|/gu, "/")} | ${item.blocker || ""} |`,
  );
  const blockerRows = report.operationalBlockers.map(
    (item, index) =>
      `| ${index + 1} | ${item.item.replace(/\|/gu, "/")} | ${item.reason.replace(/\|/gu, "/")} | ${item.impact.replace(/\|/gu, "/")} | ${item.source} |`,
  );
  const excludedRows = report.excludedItems.map(
    (item, index) =>
      `| ${index + 1} | ${item.item.replace(/\|/gu, "/")} | ${item.reason.replace(/\|/gu, "/")} | ${item.decision} | ${item.source} |`,
  );
  const planRows = report.productionPlan.map(
    (item) => `| ${item.phase} | ${item.name} | ${item.goal} | \`${item.command}\` |`,
  );
  return [
    "# 群益 API 全流程總查驗與製作清單",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- status: ${report.status}`,
    `- capitalRoot: ${report.scope.capitalRoot}`,
    `- liveTradingEnabled: ${report.summary.liveTradingEnabled}`,
    `- writeBrokerOrders: ${report.summary.writeBrokerOrders}`,
    `- actionableUnfinishedCount: ${report.summary.actionableUnfinishedCount}`,
    `- operationalBlockerCount: ${report.summary.operationalBlockerCount}`,
    `- excludedItemCount: ${report.summary.excludedItemCount}`,
    `- thousandRunRecommendation: ${report.summary.thousandRunRecommendation}`,
    `- thousandRunFixes: ${report.summary.thousandRunFixes}`,
    `- thousandRunFeatures: ${report.summary.thousandRunFeatures}`,
    `- fullChainStatus: ${report.summary.fullChainStatus}`,
    `- fullChainRuns: ${report.summary.fullChainRuns}`,
    `- simulationDiagnosticsStatus: ${report.summary.simulationDiagnosticsStatus}`,
    `- simulationDiagnosticsRuntimeErrors: ${report.summary.simulationDiagnosticsRuntimeErrors}`,
    `- qmdWalkForwardStatus: ${report.summary.qmdWalkForwardStatus}`,
    `- qmdWalkForwardTrades: ${report.summary.qmdWalkForwardTrades}`,
    `- telegramSemiApprovalStatus: ${report.summary.telegramSemiApprovalStatus}`,
    `- telegramSemiApprovalSentOrder: ${report.summary.telegramSemiApprovalSentOrder}`,
    `- telegramSemiCallbackStatus: ${report.summary.telegramSemiCallbackStatus}`,
    `- telegramSemiCallbackSentOrder: ${report.summary.telegramSemiCallbackSentOrder}`,
    `- telegramSemiCallbackProductionWrite: ${report.summary.telegramSemiCallbackProductionWrite}`,
    "",
    "## 流程查驗清單",
    "",
    "| ID | 狀態 | 流程 | 證據 | 驗證命令 |",
    "|---|---|---|---|---|",
    ...flowRows,
    "",
    "## 未製作 / 未完成清單",
    "",
    "| # | 項目 | 原因 | 影響 | 來源 |",
    "|---:|---|---|---|---|",
    ...unfinishedRows,
    "",
    "## 真實下單歸納範圍",
    "",
    "| ID | 模式 | 狀態 | 證據 | 目前阻擋 |",
    "|---|---|---|---|---|",
    ...liveOrderRows,
    "",
    "## 運行阻塞 / 需人工解除",
    "",
    "| # | 項目 | 原因 | 影響 | 來源 |",
    "|---:|---|---|---|---|",
    ...blockerRows,
    "",
    "## 明確排除 / 不再納入製作",
    "",
    "| # | 項目 | 原因 | 決策 | 來源 |",
    "|---:|---|---|---|---|",
    ...excludedRows,
    "",
    "## 最快製作順序",
    "",
    "| Phase | 任務 | 目標 | 驗證命令 |",
    "|---|---|---|---|",
    ...planRows,
    "",
    "## 固定規則",
    "",
    "- 報價只接受 fresh + matched callback，不回舊價。",
    "- 策略先 paper，真單必須通過 live promotion gate。",
    "- `tx-front` 是策略查詢語意，實際代號由 resolver 的 `matchedSymbol` 決定。",
    "- 海外全商品不是一次全訂閱；必須受 SKOS slot 限制分批驗證。",
    "",
    "## Next task",
    "",
    report.nextSafeTask,
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    writeState: false,
    json: false,
    check: false,
  };
  for (const arg of argv) {
    if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--check") {
      options.check = true;
    }
  }
  return options;
}

export async function buildCapitalMasterFlowChecklist(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const capitalRoot = path.resolve(options.capitalRoot ?? resolveCapitalHftStateDir());
  const markerFiles = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"];
  const markerStatuses = Object.fromEntries(
    await Promise.all(
      markerFiles.map(async (file) => {
        const exists = await fs.stat(path.join(repoRoot, file)).then(
          () => true,
          () => false,
        );
        return [file, checkFileStatus(exists)];
      }),
    ),
  );
  const rootOk = Object.values(markerStatuses).every((status) => status === "present");
  const packageJson = await readJsonIfExists(path.join(repoRoot, "package.json"));
  const packageScripts = new Set(Object.keys(packageJson?.scripts ?? {}));
  const [
    service,
    serviceRuntime,
    callback,
    completeness,
    readiness,
    approval,
    mergeMap,
    strategy,
    fill,
    simulation,
    fullChain,
    simulationDiagnostics,
    simulatedLive,
    liveOrderDryRunPretrade,
    telegramSimulatedLive,
    telegramSemiApproval,
    telegramSemiCallback,
    humanApproval,
    telegramHumanApproval,
    telegramHumanCallback,
    latencyGapInstrumentation,
    overseasRotation,
    walkForward,
    preTradeRiskWiring,
  ] = await Promise.all([
    readJsonIfExists(path.join(capitalRoot, "hft_service_status.json")),
    readCapitalServiceStatus({ repoRoot, capitalRoot }).catch((error) => ({
      schema: "openclaw.capital.service-status.v1",
      status: "service_status_check_failed",
      ready: false,
      service: {
        livenessStatus: "service_status_check_failed",
        pidAlive: false,
        statusFresh: false,
        statusAgeSeconds: null,
      },
      error: error instanceof Error ? error.message : String(error),
    })),
    readJsonIfExists(path.join(capitalRoot, "state", "capital_callback_readback_latest.json")),
    readJsonIfExists(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-completeness-report-latest.json",
      ),
    ),
    readJsonIfExists(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-live-strategy-readiness-latest.json",
      ),
    ),
    readJsonIfExists(path.join(repoRoot, "config", "capital-live-trading-approval.json")),
    readJsonIfExists(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-angry-bohr-merge-map-latest.json",
      ),
    ),
    readJsonIfExists(
      path.join(repoRoot, ".openclaw", "trading", "capital-strategy-engine-latest.json"),
    ),
    readJsonIfExists(
      path.join(repoRoot, ".openclaw", "trading", "capital-strategy-fill-simulation.json"),
    ),
    readJsonIfExists(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-thousand-run-simulation-latest.json",
      ),
    ),
    readJsonIfExists(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-full-chain-simulation-gate-latest.json",
      ),
    ),
    readJsonIfExists(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-simulation-diagnostics-latest.json",
      ),
    ),
    readJsonIfExists(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-simulated-live-order-mode-latest.json",
      ),
    ),
    readJsonIfExists(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-live-order-dry-run-pretrade-gate-latest.json",
      ),
    ),
    readJsonIfExists(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-telegram-simulated-live-order-latest.json",
      ),
    ),
    readJsonIfExists(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-telegram-semi-approval-gate-latest.json",
      ),
    ),
    readJsonIfExists(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-telegram-semi-approval-callback-latest.json",
      ),
    ),
    readJsonIfExists(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-live-trading-human-approval-request-latest.json",
      ),
    ),
    readJsonIfExists(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-telegram-human-approval-latest.json",
      ),
    ),
    readJsonIfExists(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-telegram-human-approval-callback-latest.json",
      ),
    ),
    readJsonIfExists(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-latency-gap-instrumentation-latest.json",
      ),
    ),
    readJsonIfExists(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-overseas-product-rotation-latest.json",
      ),
    ),
    readJsonIfExists(
      path.join(
        repoRoot,
        "reports",
        "hermes-agent",
        "state",
        "openclaw-capital-qmd-walk-forward-gate-latest.json",
      ),
    ),
    buildPreTradeRiskWiringEvidence(capitalRoot),
  ]);

  const flows = buildFlows({
    rootOk,
    service,
    serviceRuntime,
    callback,
    strategy,
    fill,
    simulation,
    fullChain,
    simulationDiagnostics,
    simulatedLive,
    liveOrderDryRunPretrade,
    telegramSimulatedLive,
    telegramSemiApproval,
    telegramSemiCallback,
    humanApproval,
    telegramHumanApproval,
    telegramHumanCallback,
    latencyGapInstrumentation,
    overseasRotation,
    walkForward,
    readiness,
    approval,
    mergeMap,
    packageScripts,
  });
  const unfinished = buildActionableUnfinished({
    completeness,
    walkForward,
    telegramSemiApproval,
    preTradeRiskWiring,
    latencyGapInstrumentation,
    overseasRotation,
  });
  const operationalBlockers = buildOperationalBlockers({
    readiness,
    approval,
    callback,
    serviceRuntime,
  });
  const excludedItems = buildExcludedItems({ mergeMap });
  const liveOrderScope = buildLiveOrderScope({ service, readiness });
  const completedCount = flows.filter((flow) => flow.status === "completed").length;
  const blockedCount = flows.filter((flow) => flow.status === "blocked").length;
  const partialCount = flows.filter((flow) => flow.status === "partial").length;
  const nextSafeTask =
    preTradeRiskWiring?.status !== "wired"
      ? "下一步完成 PreTradeRiskGate before every broker send path；仍不得啟用 live API、broker write 或真單。"
      : latencyGapInstrumentation?.status !== "passed"
        ? "下一步完成 LatencyMonitor / GapDetector tick -> signal -> order instrumentation；仍不得啟用 live API、broker write 或真單。"
        : overseasRotation?.status !== "passed"
          ? "下一步完成 Overseas product rotation beyond 64 SKOS slots；仍不得啟用 live API、broker write 或真單。"
          : Number(callback?.summary?.freshMatchedCount ?? 0) === 0
            ? "下一步修 reportable quote freshness stale symbols；仍不得回舊價、不得啟用 broker write 或真單。"
            : "下一步累積 paper-loop ready cycles；仍不得啟用 broker write 或真單。";
  const productionPlan = preferCapitalProductionPlan(buildProductionPlan());
  const validationCommands = unique(
    [
      "pnpm capital-hft:quote:reportable:check",
      "pnpm capital-hft:strategy:engine:check",
      "pnpm capital-hft:strategy:fill-simulation:json",
      "pnpm capital-hft:capital:simulation:1000:check",
      "pnpm capital-hft:capital:full-chain:check",
      "pnpm capital-hft:capital:simulation-diagnostics:check",
      "pnpm capital-hft:capital:simulated-live:check",
      "pnpm capital-hft:capital:live-order-dry-run:check",
      "pnpm capital:telegram:simulated-live:check",
      "pnpm capital:telegram:semi-approval:check",
      "pnpm capital:telegram:semi-callback:check",
      "pnpm capital-hft:live-trading:human-approval:check",
      "pnpm capital:telegram:human-approval:check",
      "pnpm capital:telegram:human-callback:check",
      "pnpm capital-hft:capital:latency-gap:check",
      "pnpm capital-hft:capital:overseas-rotation:check",
      "pnpm capital-hft:capital:walk-forward:qmd:check",
      "pnpm capital-hft:paper-loop:check",
      "pnpm capital-hft:live-strategy:readiness:check",
      "pnpm capital-hft:live-trading:approval:sync:check",
      "pnpm capital-hft:live-trading:approval:check",
      "pnpm capital-hft:live-trading:promotion:check",
      "pnpm capital-hft:capital:completeness-report:check",
      "pnpm capital-hft:capital:master-flow-checklist:check",
      "git diff --check -- package.json scripts/openclaw-capital-simulation-diagnostics.mjs scripts/check-capital-simulation-diagnostics.mjs scripts/openclaw-capital-simulated-live-order-mode.mjs scripts/check-capital-simulated-live-order-mode.mjs scripts/openclaw-capital-live-order-dry-run-pretrade-gate.mjs scripts/check-capital-live-order-dry-run-pretrade-gate.mjs scripts/openclaw-capital-telegram-semi-approval-gate.mjs scripts/check-capital-telegram-semi-approval-gate.mjs scripts/openclaw-capital-telegram-semi-approval-callback.mjs scripts/check-capital-telegram-semi-approval-callback.mjs scripts/openclaw-capital-master-flow-checklist.mjs scripts/check-capital-master-flow-checklist.mjs docs/automation/capital-api-master-flow-checklist.md",
    ].map(preferCapitalCommand),
  );

  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    status: blockedCount > 0 ? "incomplete_blocked" : partialCount > 0 ? "partial" : "completed",
    scope: {
      repoRoot,
      capitalRoot,
    },
    summary: {
      rootOk,
      completedCount,
      partialCount,
      blockedCount,
      unfinishedCount: unfinished.length,
      actionableUnfinishedCount: unfinished.length,
      operationalBlockerCount: operationalBlockers.length,
      excludedItemCount: excludedItems.length,
      thousandRunRecommendation: simulation?.recommendation ?? "missing",
      thousandRunFixes: simulation?.findings?.fixNow?.length ?? 0,
      thousandRunFeatures: simulation?.findings?.addFeatures?.length ?? 0,
      fullChainStatus: fullChain?.status ?? "missing",
      fullChainRuns: fullChain?.summary?.runs ?? 0,
      fullChainFaultFailed: fullChain?.summary?.faultFailedCount ?? null,
      simulationDiagnosticsStatus: simulationDiagnostics?.status ?? "missing",
      simulationDiagnosticsRuntimeErrors: simulationDiagnostics?.summary?.runtimeErrorCount ?? null,
      simulatedLiveStatus: simulatedLive?.status ?? "missing",
      simulatedLiveRouting: simulatedLive?.simulatedOrder?.routingDecision ?? "missing",
      simulatedLiveSentOrder: simulatedLive?.safety?.sentOrder ?? null,
      liveOrderDryRunPretradeStatus: liveOrderDryRunPretrade?.status ?? "missing",
      liveOrderDryRunPretradeAllowedToSend:
        liveOrderDryRunPretrade?.preTradeRiskGate?.allowedToSend ?? null,
      liveOrderDryRunPretradeSentOrder: liveOrderDryRunPretrade?.safety?.sentOrder ?? null,
      liveOrderDryRunPretradeBlockers:
        liveOrderDryRunPretrade?.preTradeRiskGate?.blockerCount ?? null,
      telegramSimulatedLiveStatus: telegramSimulatedLive?.status ?? "missing",
      telegramSimulatedLiveSentOrder: telegramSimulatedLive?.safety?.sentOrder ?? null,
      telegramSemiApprovalStatus: telegramSemiApproval?.status ?? "missing",
      telegramSemiApprovalSentOrder: telegramSemiApproval?.safety?.sentOrder ?? null,
      telegramSemiCallbackStatus: telegramSemiCallback?.status ?? "missing",
      telegramSemiCallbackSentOrder: telegramSemiCallback?.safety?.sentOrder ?? null,
      telegramSemiCallbackProductionWrite:
        telegramSemiCallback?.approvalWrite?.writesProductionApprovalFile ?? null,
      humanApprovalStatus: humanApproval?.status ?? "missing",
      humanApprovalAccountCount: humanApproval?.accountAllowlist?.length ?? 0,
      telegramHumanApprovalStatus: telegramHumanApproval?.status ?? "missing",
      telegramHumanCallbackStatus: telegramHumanCallback?.status ?? "missing",
      qmdWalkForwardStatus: walkForward?.status ?? "missing",
      qmdWalkForwardTrades: walkForward?.summary?.totalTestTrades ?? 0,
      latencyGapInstrumentationStatus: latencyGapInstrumentation?.status ?? "missing",
      overseasRotationStatus: overseasRotation?.status ?? "missing",
      overseasRotationPageCount: overseasRotation?.summary?.pageCount ?? null,
      overseasRotationActivePageSize: overseasRotation?.activePage?.size ?? null,
      liveTradingEnabled: service?.riskControls?.allowLiveTrading === true,
      writeBrokerOrders: service?.riskControls?.writeBrokerOrders === true,
      serviceRuntimeStatus: serviceRuntime?.status ?? "missing",
      serviceRuntimeReady: serviceRuntime?.ready ?? false,
      serviceLivenessStatus: serviceRuntime?.service?.livenessStatus ?? "missing",
      servicePidAlive: serviceRuntime?.service?.pidAlive ?? false,
      serviceStatusFresh: serviceRuntime?.service?.statusFresh ?? false,
      serviceStatusAgeSeconds: serviceRuntime?.service?.statusAgeSeconds ?? null,
      preTradeRiskWiringStatus: preTradeRiskWiring?.status ?? "missing",
      freshMatchedCount: callback?.summary?.freshMatchedCount ?? 0,
      staleSymbols: callback?.summary?.staleSymbols ?? [],
      paperRecommendation: fill?.recommendation ?? "",
      liveBlockers: readiness?.livePromotion?.blockers ?? [],
    },
    rootMarkers: markerStatuses,
    flows: preferCapitalFlowCommands(flows),
    unfinished,
    preTradeRiskWiring,
    liveOrderScope,
    operationalBlockers,
    excludedItems,
    productionPlan,
    validationCommands,
    nextSafeTask: preferCapitalCommand(nextSafeTask),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const report = await buildCapitalMasterFlowChecklist({ repoRoot });
  const jsonPath = path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-master-flow-checklist-latest.json",
  );
  const mdPath = path.join(
    repoRoot,
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-master-flow-checklist-latest.md",
  );
  const docPath = path.join(repoRoot, "docs", "automation", "capital-api-master-flow-checklist.md");
  const markdown = toMarkdown(report);
  if (options.writeState || options.check) {
    await writeJsonWithSha(jsonPath, report);
    await writeTextWithSha(mdPath, markdown);
    await writeTextWithSha(docPath, markdown);
  }
  if (options.check) {
    if (!report.summary.rootOk) {
      throw new Error("WRONG_PROJECT_ROOT");
    }
    if (!report.flows.some((flow) => flow.id === "live-promotion" && flow.status === "blocked")) {
      throw new Error("live promotion gate must stay blocked until manual approval");
    }
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(markdown);
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
