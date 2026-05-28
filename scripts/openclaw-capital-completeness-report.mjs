import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAngryBohrMergeMap } from "./openclaw-capital-angry-bohr-merge-map.mjs";
import { runCapitalLiveStrategyReadiness } from "./openclaw-capital-live-strategy-readiness.mjs";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_CAPITAL_ROOT = "D:\\群益及元大API\\CapitalHftService";
const DEFAULT_CLAUDE_SESSION =
  "C:\\Users\\user\\.claude\\projects\\D--OpenClaw--claude-worktrees-angry-bohr-619b69\\de922c2c-2a92-4782-ac06-c233c74cd58b.jsonl";
const DEFAULT_JSON_REPORT = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-completeness-report-latest.json",
);
const DEFAULT_MD_REPORT = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-completeness-report-latest.md",
);
const DEFAULT_LATENCY_GAP_REPORT = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-latency-gap-instrumentation-latest.json",
);
const DEFAULT_OVERSEAS_ROTATION_REPORT = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-overseas-product-rotation-latest.json",
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

async function readTextOptional(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function hasAll(text, needles) {
  return needles.every((needle) => text.includes(needle));
}

async function buildPreTradeRiskWiringEvidence(capitalRoot) {
  const serviceText = await readTextOptional(path.join(capitalRoot, "CapitalHftService.cs"));
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

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

function pathForMarkdown(filePath) {
  return filePath.replaceAll("\\", "/");
}

function formatList(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return "無";
  }
  return values.map((item) => `- ${item}`).join("\n");
}

async function readTail(filePath, byteCount = 262_144) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(byteCount, stat.size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function summarizeClaudeSession(sessionPath) {
  try {
    const tail = await readTail(sessionPath);
    const lines = tail.split(/\r?\n/u).filter(Boolean);
    let lastPrompt = "";
    let rateLimit = false;
    let auditReportFound = false;
    let auditExtract = [];

    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof record.lastPrompt === "string") {
        lastPrompt = record.lastPrompt;
      }
      if (record.error === "rate_limit") {
        rateLimit = true;
      }
      const content = record.message?.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          const texts = [];
          if (item.type === "text" && typeof item.text === "string") {
            texts.push(item.text);
          }
          if (item.type === "tool_result" && Array.isArray(item.content)) {
            for (const nested of item.content) {
              if (typeof nested.text === "string") {
                texts.push(nested.text);
              }
            }
          }
          for (const text of texts) {
            if (text.includes("You've hit your limit")) {
              rateLimit = true;
            }
            if (text.includes("完整功能稽核報告")) {
              auditReportFound = true;
              auditExtract = text
                .split(/\r?\n/u)
                .filter((row) =>
                  /^(####|###|##|[-*] |✅|❌|⚠️|### 🔴|### 🟠|問題|缺失|影響)/u.test(row.trim()),
                )
                .slice(0, 80);
            }
          }
        }
      }
    }

    return {
      sessionPath,
      exists: true,
      lastPrompt,
      stoppedByRateLimit: rateLimit,
      auditReportFound,
      auditExtract,
    };
  } catch (error) {
    return {
      sessionPath,
      exists: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildReportObject(inputs) {
  const {
    now,
    hftStatus,
    callbackReadback,
    approval,
    readiness,
    mergeMap,
    claude,
    preTradeRiskWiring,
    latencyGapInstrumentation,
    overseasRotation,
  } = inputs;
  const liveBlockers = readiness.livePromotion?.blockers ?? [];
  const mergeCategories = mergeMap.summary?.categories ?? {};
  const staleSymbols = callbackReadback.summary?.staleSymbols ?? [];
  const callbackItems = Array.isArray(callbackReadback.items) ? callbackReadback.items : [];
  const actionableStaleItems = callbackItems.filter((item) => {
    const freshMatched = item?.freshMatched === true;
    if (freshMatched) {
      return false;
    }
    const reason = String(item?.reason ?? "");
    const sessionOpen = item?.session?.open;
    // 休市 stale（如 weekend/closed session）只做資訊顯示，不阻擋完整性閉環。
    if (reason === "closed_session_stale" || sessionOpen === false) {
      return false;
    }
    return true;
  });
  const actionableStaleSymbols = actionableStaleItems
    .map((item) =>
      String(item?.query ?? item?.canonicalSymbol ?? item?.matchedSymbol ?? "")
        .toUpperCase()
        .trim(),
    )
    .filter(Boolean);
  const staleBlockedByClosedSessionOnly =
    staleSymbols.length > 0 && actionableStaleSymbols.length === 0;
  const approvalAllowlistCount = Array.isArray(approval.accountAllowlist)
    ? approval.accountAllowlist.length
    : 0;
  const approvalHasRollbackPlan =
    typeof approval.rollbackPlan === "string" && approval.rollbackPlan.trim().length > 0;
  const approvalClear =
    approval.humanApproved === true &&
    approvalAllowlistCount > 0 &&
    approval.killSwitch === true &&
    approvalHasRollbackPlan;
  const semiApprovalClear =
    readiness.semiApproval?.clear === true || !liveBlockers.includes("live:semi-approval-required");
  const latencyGapClear =
    latencyGapInstrumentation?.schema === "openclaw.capital.latency-gap-instrumentation.v1" &&
    latencyGapInstrumentation?.status === "passed";
  const overseasRotationClear =
    overseasRotation?.schema === "openclaw.capital.overseas-product-rotation.v1" &&
    overseasRotation?.status === "passed";
  const mergeMapBlocked = (mergeCategories.blocked_runtime ?? 0) > 0;
  const callbackStaleBlocked =
    callbackReadback.quoteFreshAllowed === false && actionableStaleSymbols.length > 0;

  const completed = [
    {
      item: "群益 CapitalHftService 實際服務已啟動",
      status: hftStatus.status === "running" ? "done" : "needs_fix",
      evidence: `status=${hftStatus.status ?? "unknown"}, pid=${hftStatus.pid ?? ""}`,
    },
    {
      item: "群益登入與報價連線",
      status:
        hftStatus.loginStatus === "connected" && hftStatus.loginCode === 0 ? "done" : "needs_fix",
      evidence: `loginStatus=${hftStatus.loginStatus ?? ""}, loginCode=${hftStatus.loginCode ?? ""}, method=${hftStatus.loginMethod ?? ""}`,
    },
    {
      item: "國內報價 callback",
      status: hftStatus.quoteMonitorConnected === true ? "done" : "needs_fix",
      evidence: `quoteCount=${hftStatus.quoteStats?.quoteCount ?? 0}, lastQuoteAt=${hftStatus.quoteStats?.lastQuoteAt ?? ""}`,
    },
    {
      item: "海外報價 callback",
      status: hftStatus.osQuoteConnected === true ? "done" : "needs_fix",
      evidence: `osQuoteCount=${hftStatus.osQuoteStats?.quoteCount ?? 0}, lastQuoteAt=${hftStatus.osQuoteStats?.lastQuoteAt ?? ""}`,
    },
    {
      item: "策略 paper evaluator",
      status: readiness.paperStrategy?.recommendation === "promote" ? "done" : "needs_fix",
      evidence: `recommendation=${readiness.paperStrategy?.recommendation ?? ""}, passCount=${readiness.paperStrategy?.passCount ?? ""}/5`,
    },
    {
      item: "Claude angry-bohr merge-map",
      status: mergeMap.ready === true ? "done" : "needs_fix",
      evidence: `total=${mergeMap.summary?.totalDiffPaths ?? 0}, requires_adapter=${mergeCategories.requires_adapter ?? 0}, blocked_runtime=${mergeCategories.blocked_runtime ?? 0}, do_not_merge=${mergeCategories.do_not_merge ?? 0}`,
    },
    {
      item: "真單自動化安全阻擋",
      status: readiness.capabilities?.liveTradingExecution === false ? "done" : "unsafe",
      evidence: `liveTradingExecution=${readiness.capabilities?.liveTradingExecution}, brokerWriteExecution=${readiness.capabilities?.brokerWriteExecution}`,
    },
  ];

  const aborted = [
    {
      item: "Claude 剛剛的完整規劃/稽核流程",
      status: claude.stoppedByRateLimit ? "interrupted" : "unknown",
      evidence: claude.stoppedByRateLimit
        ? "Claude session 最後出現 rate_limit，流程中斷。"
        : "未從 session 尾端確認 rate_limit。",
    },
    {
      item: "直接整包融合 angry-bohr",
      status: "aborted_by_safety",
      evidence: `merge-map 顯示 ${mergeCategories.requires_adapter ?? 0} 個 requires_adapter、${mergeCategories.blocked_runtime ?? 0} 個 blocked_runtime、${mergeCategories.do_not_merge ?? 0} 個 do_not_merge。`,
    },
    {
      item: "直接開啟真實下單",
      status: "blocked_by_gate",
      evidence: `blockers=${liveBlockers.join(",")}`,
    },
  ];

  const planned = [
    {
      item: "建立 paper strategy controlled loop",
      purpose: "策略先用真實 fresh quote 驅動，但只輸出 paper decision / simulated fill。",
      gate: "live-strategy readiness status 必須為 paper_ready_live_blocked。",
    },
    {
      item: "補 StrategyRunner 真單前固定順序",
      purpose:
        "PreTradeRiskGate -> SEMI approval -> latency/gap instrumentation -> broker send adapter。",
      gate: "所有 gate pass 前不得啟用 live write。",
    },
    {
      item: "逐項吸收 angry-bohr requires_adapter",
      purpose: "只吸收可轉成 OpenClaw-safe adapter 的策略/風控/資料模組。",
      gate: "每一項必須有 node --check 與對應 check script。",
    },
    {
      item: "修正報價 stale symbols",
      purpose:
        "TX06AM / XE0000AM 若交易時段中 stale，必須輸出 blocked 原因；TX05AM 屬過期路徑不得再當 active target。",
      gate: "callback readback freshMatched 或明確 blocked。",
    },
  ];

  const unfinished = [
    preTradeRiskWiring.status === "wired"
      ? null
      : {
          item: "PreTradeRiskGate 真正接入送單前",
          reason: "Claude 稽核指出 class 已建立，但送單前尚未確認固定呼叫。",
          impact: "未完成前不能開真單。",
        },
    semiApprovalClear
      ? null
      : {
          item: "SEMI approval 真正阻塞等待人工批准",
          reason: `readiness semiApproval.clear=${readiness.semiApproval?.clear ?? "unknown"}，liveBlockers=${liveBlockers.join(",") || "none"}`,
          impact: "未完成前不能開真單。",
        },
    latencyGapClear
      ? null
      : {
          item: "LatencyMonitor / GapDetector 主流程埋點",
          reason: "class 存在但 tick -> signal -> order 未確認完整接線。",
          impact: "未完成前無法做 HFT 延遲/跳空風控證明。",
        },
    overseasRotationClear
      ? null
      : {
          item: "Overseas product rotation beyond 64 SKOS slots",
          reason: "SKOSQuoteLib 只能穩定處理 64 檔 active page；全商品需要分頁輪詢 manifest。",
          impact: "未完成前不能宣稱海外全商品可覆蓋。",
        },
    approvalClear
      ? null
      : {
          item: "live approval 人工核准檔",
          reason: `humanApproved=${approval.humanApproved ?? "unknown"}、accountAllowlist=${approvalAllowlistCount}、killSwitch=${approval.killSwitch ?? "unknown"}、hasRollbackPlan=${approvalHasRollbackPlan}`,
          impact: "live promotion gate 保持 blocked。",
        },
    mergeMapBlocked
      ? {
          item: "angry-bohr blocked_runtime 清理",
          reason: `blocked_runtime=${mergeCategories.blocked_runtime ?? 0}`,
          impact: "blocked_runtime 清零前不可整包 merge。",
        }
      : null,
    callbackStaleBlocked
      ? {
          item: "callback readback stale symbols",
          reason: `quoteFreshAllowed=${callbackReadback.quoteFreshAllowed ?? "unknown"}，actionable stale symbols: ${actionableStaleSymbols.join(", ")}`,
          impact: "stale 時只能 blocked，不可回舊價。",
        }
      : null,
  ].filter(Boolean);

  const verificationChecklist = [
    "pwd 必須是 D:\\OpenClaw",
    "git rev-parse --show-toplevel 必須是 D:/OpenClaw",
    "package.json / pnpm-workspace.yaml / pnpm-lock.yaml 必須存在",
    "pnpm capital-hft:live-strategy:readiness:check",
    "pnpm capital-hft:paper-hft:evaluate:check",
    "pnpm capital-hft:capital:latency-gap:check",
    "pnpm capital-hft:capital:overseas-rotation:check",
    "pnpm capital-hft:live-trading:promotion:check",
    "pnpm capital-hft:capital-api:agent:check 或現有 Capital gate",
    "node --check scripts/openclaw-capital-completeness-report.mjs",
    "git diff --check -- 本輪新增/修改檔案",
  ];

  return {
    schema: "openclaw.capital.completeness-report.v1",
    generatedAt: now.toISOString(),
    status:
      readiness.status === "paper_ready_live_blocked" ? "paper_ready_live_blocked" : "blocked",
    scope: {
      repoRoot,
      capitalRoot: DEFAULT_CAPITAL_ROOT,
      angryBohrWorktree: mergeMap.source?.worktreePath ?? "",
      claudeSession: claude.sessionPath,
    },
    headline: {
      paperStrategyReady: readiness.capabilities?.paperStrategyExecution === true,
      liveTradingReady: false,
      brokerWriteReady: false,
      safeToEnableLiveNow: false,
      reason: "paper 策略可用；真實下單仍被 promotion gate 阻擋。",
    },
    completed,
    aborted,
    planned,
    unfinished,
    verificationChecklist,
    evidence: {
      hftStatus: {
        status: hftStatus.status ?? "unknown",
        loginStatus: hftStatus.loginStatus ?? "unknown",
        quoteMonitorConnected: hftStatus.quoteMonitorConnected ?? false,
        osQuoteConnected: hftStatus.osQuoteConnected ?? false,
        orderInitialized: hftStatus.orderInitialized ?? false,
        allowLiveTrading: hftStatus.riskControls?.allowLiveTrading ?? null,
        writeBrokerOrders: hftStatus.riskControls?.writeBrokerOrders ?? null,
      },
      callbackReadback: {
        quoteFreshAllowed: callbackReadback.quoteFreshAllowed ?? null,
        freshMatchedCount: callbackReadback.summary?.freshMatchedCount ?? null,
        staleOrMissingCount: callbackReadback.summary?.staleOrMissingCount ?? null,
        staleSymbols,
        actionableStaleSymbols,
        staleBlockedByClosedSessionOnly,
      },
      preTradeRiskWiring,
      approval: {
        humanApproved: approval.humanApproved ?? null,
        approvalStatus: approval.approvalStatus ?? "",
        accountAllowlistCount: approvalAllowlistCount,
        killSwitch: approval.killSwitch ?? null,
        hasRollbackPlan: approvalHasRollbackPlan,
      },
      readiness: {
        status: readiness.status,
        paperStrategyExecution: readiness.capabilities?.paperStrategyExecution,
        liveTradingExecution: readiness.capabilities?.liveTradingExecution,
        brokerWriteExecution: readiness.capabilities?.brokerWriteExecution,
        liveBlockers,
      },
      latencyGapInstrumentation: {
        status: latencyGapInstrumentation?.status ?? "missing",
        tickToSignalRecordCalls:
          latencyGapInstrumentation?.staticEvidence?.counts?.tickToSignalRecordCalls ?? null,
        orderRoundTripRecordCalls:
          latencyGapInstrumentation?.staticEvidence?.counts?.orderRoundTripRecordCalls ?? null,
      },
      overseasRotation: {
        status: overseasRotation?.status ?? "missing",
        productCount: overseasRotation?.summary?.productCount ?? null,
        pageCount: overseasRotation?.summary?.pageCount ?? null,
        activePageSize: overseasRotation?.activePage?.size ?? null,
        maxPageSize: overseasRotation?.summary?.maxPageSize ?? null,
      },
      mergeMap: {
        status: mergeMap.status,
        totalDiffPaths: mergeMap.summary?.totalDiffPaths ?? 0,
        categories: mergeCategories,
      },
      claude: {
        exists: claude.exists,
        stoppedByRateLimit: claude.stoppedByRateLimit,
        lastPrompt: claude.lastPrompt,
        auditReportFound: claude.auditReportFound,
        auditExtract: claude.auditExtract ?? [],
      },
    },
    nextSafeTask:
      readiness.status === "paper_ready_live_blocked" && unfinished.length === 0
        ? "paper 策略閉環已就緒；下一步只做人工 live promotion 審核（approval + kill switch + rollback），在核准前維持 broker write/真單關閉。"
        : preTradeRiskWiring.status !== "wired"
          ? "先補 StrategyRunner/CapitalHftService 的 PreTradeRiskGate + SEMI approval + latency/gap instrumentation 固定送單前順序；完成後重跑 completeness report 與 live-strategy readiness。"
          : !latencyGapClear
            ? "下一步補 LatencyMonitor / GapDetector 主流程埋點；完成後重跑 completeness report 與 live-strategy readiness。"
            : !overseasRotationClear
              ? "下一步完成 Overseas product rotation beyond 64 SKOS slots；仍不得啟用 live API、broker write 或真單。"
              : !approvalClear
                ? "下一步補 live approval 人工核准檔與 rollback plan；在 approval gate 仍 blocked 前不得啟用 broker write 或真單。"
                : mergeMapBlocked
                  ? "下一步清理 angry-bohr blocked_runtime / do_not_merge 項，逐項吸收為 OpenClaw-safe adapter，不可整包 merge。"
                  : callbackStaleBlocked
                    ? "下一步修 reportable quote freshness stale symbols；仍不得回舊價、不得啟用 broker write 或真單。"
                    : staleBlockedByClosedSessionOnly
                      ? "callback stale 目前僅屬休市資訊，不阻擋閉環；下一步維持 paper-only 例行檢查與報告同步。"
                      : "下一步維持 paper-only 例行檢查與報告同步；無需啟用 broker write 或真單。",
  };
}

function renderMarkdown(report) {
  const completed = report.completed
    .map((item) => `- ${item.status}: ${item.item} (${item.evidence})`)
    .join("\n");
  const aborted = report.aborted
    .map((item) => `- ${item.status}: ${item.item} (${item.evidence})`)
    .join("\n");
  const planned = report.planned
    .map((item) => `- ${item.item}: ${item.purpose} Gate: ${item.gate}`)
    .join("\n");
  const unfinished = report.unfinished
    .map((item) => `- ${item.item}: ${item.reason} Impact: ${item.impact}`)
    .join("\n");
  const liveBlockers = report.evidence.readiness.liveBlockers;

  return `# OpenClaw Capital API 完整性報告

Generated: ${report.generatedAt}

## 核心結論

- Paper 策略狀態: ${report.headline.paperStrategyReady ? "READY" : "BLOCKED"}
- 真實下單狀態: BLOCKED
- Broker write 狀態: BLOCKED
- 可否現在直接開真單: NO
- 原因: ${report.headline.reason}

## 範圍

- OpenClaw 主線: [${pathForMarkdown(report.scope.repoRoot)}](${pathForMarkdown(report.scope.repoRoot)})
- CapitalHftService: [${pathForMarkdown(report.scope.capitalRoot)}](${pathForMarkdown(report.scope.capitalRoot)})
- angry-bohr worktree: [${pathForMarkdown(report.scope.angryBohrWorktree)}](${pathForMarkdown(report.scope.angryBohrWorktree)})
- Claude session: [${pathForMarkdown(report.scope.claudeSession)}](${pathForMarkdown(report.scope.claudeSession)})

## 已完成

${completed}

## 流產 / 中斷 / 已阻擋

${aborted}

## 已規劃

${planned}

## 未完成

${unfinished}

## 真單 blocker

${formatList(liveBlockers)}

## 檢驗清單

${formatList(report.verificationChecklist)}

## 目前要做什麼

${report.nextSafeTask}
`;
}

export async function runCapitalCompletenessReport(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const capitalRoot = path.resolve(options.capitalRoot || DEFAULT_CAPITAL_ROOT);
  const jsonReportPath = path.resolve(options.jsonReportPath || DEFAULT_JSON_REPORT);
  const mdReportPath = path.resolve(options.mdReportPath || DEFAULT_MD_REPORT);
  const claudeSessionPath = path.resolve(options.claudeSessionPath || DEFAULT_CLAUDE_SESSION);

  const [
    hftStatus,
    callbackReadback,
    approval,
    readinessResult,
    mergeMap,
    claude,
    preTradeRiskWiring,
    latencyGapInstrumentation,
    overseasRotation,
  ] = await Promise.all([
    readJsonOptional(path.join(capitalRoot, "hft_service_status.json")),
    readJsonOptional(path.join(capitalRoot, "state", "capital_callback_readback_latest.json")),
    readJsonOptional(path.join(repoRoot, "config", "capital-live-trading-approval.json")),
    runCapitalLiveStrategyReadiness({ capitalRoot, writeState: options.writeState === true }),
    buildAngryBohrMergeMap({ now }),
    summarizeClaudeSession(claudeSessionPath),
    buildPreTradeRiskWiringEvidence(capitalRoot),
    readJsonOptional(DEFAULT_LATENCY_GAP_REPORT),
    readJsonOptional(DEFAULT_OVERSEAS_ROTATION_REPORT),
  ]);

  const report = buildReportObject({
    now,
    hftStatus,
    callbackReadback,
    approval,
    readiness: readinessResult.report,
    mergeMap,
    claude,
    preTradeRiskWiring,
    latencyGapInstrumentation,
    overseasRotation,
  });
  const markdown = renderMarkdown(report);

  if (options.writeState === true) {
    await writeTextWithSha(jsonReportPath, `${JSON.stringify(report, null, 2)}\n`);
    await writeTextWithSha(mdReportPath, markdown);
  }

  return { report, markdown, jsonReportPath, mdReportPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  const result = await runCapitalCompletenessReport({
    capitalRoot: argValue("--capital-root", DEFAULT_CAPITAL_ROOT),
    jsonReportPath: argValue("--json-report", DEFAULT_JSON_REPORT),
    mdReportPath: argValue("--md-report", DEFAULT_MD_REPORT),
    claudeSessionPath: argValue("--claude-session", DEFAULT_CLAUDE_SESSION),
    writeState: hasFlag("--write-state"),
  });

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        "OpenClaw Capital completeness report",
        `status=${result.report.status}`,
        `paperStrategyReady=${result.report.headline.paperStrategyReady}`,
        `liveTradingReady=${result.report.headline.liveTradingReady}`,
        `brokerWriteReady=${result.report.headline.brokerWriteReady}`,
        `nextSafeTask=${result.report.nextSafeTask}`,
      ].join("\n") + "\n",
    );
  }
}
