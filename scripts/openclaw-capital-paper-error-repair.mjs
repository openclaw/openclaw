#!/usr/bin/env node
// openclaw-capital-paper-error-repair.mjs — 自我修復/錯誤診斷模組
// 只做唯讀診斷與修復記錄，禁止任何登入、真實下單或 broker 寫入
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── 輔助函式 ────────────────────────────────────────────────────────────

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeJsonWithSha(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function readOptionalJson(filePath, fallback) {
  try {
    return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^﻿/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

// ── 修復歷史讀取 ──────────────────────────────────────────────────────

async function readRepairHistory(historyPath) {
  try {
    const text = await fs.readFile(historyPath, "utf8");
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const entries = lines.flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    return entries;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function countConsecutiveErrors(entries) {
  let count = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].repairStatus === "healthy") {
      break;
    }
    count += 1;
  }
  return count;
}

// ── 安全檢查 ──────────────────────────────────────────────────────────

function runSafetyChecks(loopReport) {
  return {
    noLoginAttempted: loopReport?.loginAttempted === false,
    noLiveTradingEnabled: loopReport?.liveTradingEnabled === false,
    noWriteTradingEnabled: loopReport?.writeTradingEnabled === false,
    noBrokerWriteEnabled: loopReport?.brokerOrderPathEnabled === false,
    readOnlyRepairOnly: true,
  };
}

function safetyChecksPassed(checks) {
  return (
    checks.noLoginAttempted === true &&
    checks.noLiveTradingEnabled === true &&
    checks.noWriteTradingEnabled === true &&
    checks.noBrokerWriteEnabled === true &&
    checks.readOnlyRepairOnly === true
  );
}

function summarizeAutoReview(autoReviewReport, autoReviewReportPath) {
  const failedRules = Array.isArray(autoReviewReport?.failedRules)
    ? autoReviewReport.failedRules
    : [];
  const recommendation =
    autoReviewReport?.evaluationRef?.recommendation ??
    autoReviewReport?.recommendation ??
    "unknown";
  const sourceIntegrityOk =
    autoReviewReport?.evaluationRef?.sourceIntegrityOk === true ||
    autoReviewReport?.status === "no_data";

  return {
    autoReviewReportPath,
    autoReviewFound: autoReviewReport !== null,
    status: autoReviewReport?.status ?? "missing",
    recommendation,
    sourceIntegrityOk,
    promotionBlocked: autoReviewReport?.promotionBlocked === true,
    currentEvaluationApproved: autoReviewReport?.currentEvaluationApproved === true,
    failedRuleCount: failedRules.length,
  };
}

function buildNextAction(classification, paperReview) {
  if (classification.repairStatus !== "healthy") {
    return `先處理 ${classification.repairAction}，保持 paper-only，不得登入或寫入 broker。`;
  }

  if (paperReview.promotionBlocked) {
    if (!paperReview.sourceIntegrityOk) {
      return "paper loop 健康，但 paper auto-review 來源完整性未通過；維持 paper-only，禁止新晉升，先修正錯誤商品/unsafe intent 後重跑 fill/evaluator/auto-review。";
    }
    return "paper loop 健康，但最新策略評估仍 reject；維持 paper-only，禁止新晉升，先修正策略樣本/風控規則後重跑 evaluator。";
  }

  return "paper loop 健康；可進入下一個 paper-only 驗證任務，不得直接推進 live。";
}

// ── 錯誤分類與修復策略 ────────────────────────────────────────────────

async function classifyAndRepair(loopReport, burstReport, architectureReportPath, dryRun) {
  const loopStatus = loopReport?.status ?? "unknown";

  // 1. blocked_architecture
  if (loopStatus === "blocked_architecture") {
    const archReport = await readOptionalJson(architectureReportPath, null);
    const failedGates = archReport?.summary?.failed ?? archReport?.failed ?? [];
    const details = {
      architectureReportPath,
      archReportFound: archReport !== null,
      failedGates,
      note: "Architecture gate 失敗，需要 repo 修正，無法自動修復",
    };
    return {
      errorType: "architecture_gate_failed",
      repairAction: "document_missing_components",
      repairStatus: "documented",
      details,
      repairNotes: {
        schema: "openclaw.capital.paper-repair-notes.v1",
        generatedAt: new Date().toISOString(),
        loopStatus,
        errorType: "architecture_gate_failed",
        failedGates,
        message: `Architecture gate 失敗：共 ${failedGates.length} 個 gate 未通過。需要 repo 修正，不可自動修復。`,
        requiredAction: "請依照 failedGates 清單修正缺少的腳本/設定檔",
        dryRun,
      },
    };
  }

  // 2. blocked_readiness
  if (loopStatus === "blocked_readiness") {
    const quoteAgeSeconds = loopReport?.readiness?.quoteAgeSeconds ?? null;
    const maxQuoteAgeSeconds = loopReport?.readiness?.maxQuoteAgeSeconds ?? null;
    const failedGates = loopReport?.readiness?.failed ?? [];

    const isStaleQuote =
      quoteAgeSeconds !== null &&
      maxQuoteAgeSeconds !== null &&
      quoteAgeSeconds > maxQuoteAgeSeconds;

    if (isStaleQuote) {
      return {
        errorType: "stale_quote",
        repairAction: "await_fresh_quote",
        repairStatus: "awaiting_quote",
        details: {
          quoteAgeSeconds,
          maxQuoteAgeSeconds,
          staleness: quoteAgeSeconds - maxQuoteAgeSeconds,
          note: "報價過期，等待 CapitalHftService 寫入新的 SKQuoteLib quote callback",
        },
      };
    }

    return {
      errorType: "readiness_gate_failed",
      repairAction: "document_readiness_failures",
      repairStatus: "documented",
      details: {
        failedGates,
        quoteAgeSeconds,
        maxQuoteAgeSeconds,
        note: "Readiness gate 失敗（非報價過期），需手動檢查失敗項目",
      },
    };
  }

  // 3. session_closed
  if (loopStatus === "session_closed") {
    return {
      errorType: "session_closed",
      repairAction: "await_session_open",
      repairStatus: "awaiting_session",
      details: {
        note: "市場交易時段未開啟，等待台指日盤/夜盤開盤",
      },
    };
  }

  // 4. blocked_1115
  if (loopStatus === "blocked_1115") {
    return {
      errorType: "guard_cooldown",
      repairAction: "await_cooldown",
      repairStatus: "awaiting_cooldown",
      details: {
        note: "Guard cooldown (1115) 生效中，禁止登入/推進 StartIndex",
      },
    };
  }

  // 5. healthy statuses
  if (loopStatus === "paper_intent_created" || loopStatus === "no_signal") {
    return {
      errorType: "none",
      repairAction: "none",
      repairStatus: "healthy",
      details: {
        note: `系統正常運作，狀態: ${loopStatus}`,
      },
    };
  }

  // 6. error or unknown
  const errorMessage =
    loopReport?.error ?? loopReport?.errorMessage ?? loopReport?.message ?? "（無詳細訊息）";
  return {
    errorType: "unknown_error",
    repairAction: "document_error",
    repairStatus: "documented_error",
    details: {
      loopStatus,
      errorMessage,
      burstStatus: burstReport?.status ?? "unknown",
      note: `未知錯誤狀態: ${loopStatus}，已記錄供人工檢查`,
    },
  };
}

// ── 主要匯出函式 ──────────────────────────────────────────────────────

export async function runCapitalPaperErrorRepair(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const loopReportPath = path.resolve(
    options.loopReportPath ||
      path.join(repoRoot, ".openclaw", "trading", "capital-paper-automation-loop-latest.json"),
  );
  const burstReportPath = path.resolve(
    options.burstReportPath ||
      path.join(repoRoot, ".openclaw", "trading", "capital-paper-hft-burst-latest.json"),
  );
  const repairHistoryPath = path.resolve(
    options.repairHistoryPath ||
      path.join(repoRoot, ".openclaw", "trading", "capital-paper-repair-history.jsonl"),
  );
  const autoReviewReportPath = path.resolve(
    options.autoReviewReportPath ||
      path.join(repoRoot, ".openclaw", "trading", "capital-paper-auto-review-latest.json"),
  );
  const outputPath = path.resolve(
    options.outputPath ||
      path.join(repoRoot, ".openclaw", "trading", "capital-paper-error-repair-latest.json"),
  );
  const repairNotesPath = path.join(path.dirname(outputPath), "capital-paper-repair-notes.json");
  const architectureReportPath = path.join(
    repoRoot,
    ".openclaw",
    "quote",
    "capital-quote-architecture-report.json",
  );
  const dryRun = options.dryRun === true;

  // 讀取兩份報告（optional — 允許不存在）
  const loopReport = await readOptionalJson(loopReportPath, null);
  const burstReport = await readOptionalJson(burstReportPath, null);
  const autoReviewReport = await readOptionalJson(autoReviewReportPath, null);
  const paperReview = summarizeAutoReview(autoReviewReport, autoReviewReportPath);

  // 安全檢查
  const safetyChecks = runSafetyChecks(loopReport ?? {});
  if (!safetyChecksPassed(safetyChecks)) {
    const violation = {
      schema: "openclaw.capital.paper-error-repair.v1",
      generatedAt: new Date().toISOString(),
      dryRun,
      loopStatus: loopReport?.status ?? "unknown",
      errorType: "safety_violation",
      repairStatus: "safety_violation",
      repairAction: "none",
      readOnly: true,
      loginAttempted: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      brokerOrderPathEnabled: false,
      details: {
        safetyViolationReason: "安全檢查失敗：偵測到潛在的登入或真實交易狀態，拒絕執行任何修復動作",
        safetyChecks,
      },
      safetyChecks,
      paperReview,
      promotionBlocked: true,
      currentEvaluationApproved: false,
      nextAction: "停止修復動作並檢查 paper loop 安全欄位，不得登入或寫入 broker。",
      repairHistory: {
        totalRepairs: 0,
        lastRepairAt: "",
        consecutiveErrors: 0,
      },
    };
    if (!dryRun) {
      await writeJsonWithSha(outputPath, violation);
    }
    return violation;
  }

  // 分類錯誤並產生修復策略
  const loopStatus = loopReport?.status ?? "unknown";
  const classification = await classifyAndRepair(
    loopReport,
    burstReport,
    architectureReportPath,
    dryRun,
  );

  // 讀取修復歷史
  const historyEntries = await readRepairHistory(repairHistoryPath);
  const consecutiveErrors = countConsecutiveErrors(historyEntries);
  const lastEntry = historyEntries.at(-1);

  const repairHistory = {
    totalRepairs: historyEntries.length,
    lastRepairAt: lastEntry?.ts ?? "",
    consecutiveErrors,
  };

  // 組裝輸出
  const output = {
    schema: "openclaw.capital.paper-error-repair.v1",
    generatedAt: new Date().toISOString(),
    dryRun,
    loopStatus,
    errorType: classification.errorType,
    repairStatus: classification.repairStatus,
    repairAction: classification.repairAction,
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    details: classification.details,
    safetyChecks,
    paperReview,
    promotionBlocked: paperReview.promotionBlocked,
    currentEvaluationApproved: paperReview.currentEvaluationApproved,
    nextAction: buildNextAction(classification, paperReview),
    repairHistory,
  };

  if (!dryRun) {
    // 寫入輸出報告（含 SHA256 sidecar）
    await writeJsonWithSha(outputPath, output);

    // 寫入修復歷史 JSONL
    await appendJsonLine(repairHistoryPath, {
      ts: output.generatedAt,
      loopStatus,
      errorType: classification.errorType,
      repairStatus: classification.repairStatus,
      repairAction: classification.repairAction,
    });

    // 若有 architecture 或 readiness 問題，寫入修復備註
    if (classification.repairNotes) {
      await writeJsonWithSha(repairNotesPath, classification.repairNotes);
    }
  }

  return output;
}

// ── CLI ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    loopReportPath: "",
    burstReportPath: "",
    repairHistoryPath: "",
    outputPath: "",
    dryRun: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--loop-report") {
      options.loopReportPath = argv[++index] ?? options.loopReportPath;
    } else if (arg.startsWith("--loop-report=")) {
      options.loopReportPath = arg.slice("--loop-report=".length);
    } else if (arg === "--burst-report") {
      options.burstReportPath = argv[++index] ?? options.burstReportPath;
    } else if (arg.startsWith("--burst-report=")) {
      options.burstReportPath = arg.slice("--burst-report=".length);
    } else if (arg === "--repair-history") {
      options.repairHistoryPath = argv[++index] ?? options.repairHistoryPath;
    } else if (arg.startsWith("--repair-history=")) {
      options.repairHistoryPath = arg.slice("--repair-history=".length);
    } else if (arg === "--auto-review-report") {
      options.autoReviewReportPath = argv[++index] ?? options.autoReviewReportPath;
    } else if (arg.startsWith("--auto-review-report=")) {
      options.autoReviewReportPath = arg.slice("--auto-review-report=".length);
    } else if (arg === "--output") {
      options.outputPath = argv[++index] ?? options.outputPath;
    } else if (arg.startsWith("--output=")) {
      options.outputPath = arg.slice("--output=".length);
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    }
  }
  return options;
}

function formatSummary(report) {
  return `repair=${report.repairStatus} action=${report.repairAction} loopStatus=${report.loopStatus}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await runCapitalPaperErrorRepair(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatSummary(report)}\n`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital paper error repair failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
