/**
 * check-capital-paper-auto-review.mjs
 *
 * Gate check：以 writeState: false 執行 auto-review，驗證三項安全標記，
 * 全部通過才輸出 CAPITAL_PAPER_AUTO_REVIEW_CHECK=OK，否則 throw Error。
 *
 * 安全約束：
 *   writeState: false（僅讀取，不修改任何檔案）
 *   allowLiveTrading: false（絕不設為 true）
 *   writeBrokerOrders: false（絕不設為 true）
 *   promoteLiveAutomatically: false（絕不設為 true）
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCapitalPaperAutoReview } from "./openclaw-capital-paper-auto-review.mjs";

async function assertIntegrityBlocksAlreadyApproved() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auto-review-"));
  const evaluationPath = path.join(
    tempRoot,
    ".openclaw",
    "trading",
    "capital-paper-strategy-evaluation.json",
  );
  const strategyPath = path.join(tempRoot, "config", "capital-paper-microstructure-strategy.json");
  const registryPath = path.join(
    tempRoot,
    ".openclaw",
    "trading",
    "capital-paper-learning-registry.json",
  );
  const reviewReportPath = path.join(
    tempRoot,
    ".openclaw",
    "trading",
    "capital-paper-auto-review-latest.json",
  );
  await Promise.all([
    fs.mkdir(path.dirname(evaluationPath), { recursive: true }),
    fs.mkdir(path.dirname(strategyPath), { recursive: true }),
    fs.mkdir(path.dirname(registryPath), { recursive: true }),
  ]);
  await fs.writeFile(
    evaluationPath,
    `${JSON.stringify({
      recommendation: "promote",
      passCount: 6,
      ruleCount: 6,
      rules: {},
      summary: {
        total_intents: 7,
        normalized_legacy_alias_count: 1,
      },
      failedRules: [],
    })}\n`,
    "utf8",
  );
  await fs.writeFile(
    strategyPath,
    `${JSON.stringify({
      allowLiveTrading: false,
      writeBrokerOrders: false,
      learning: {
        status: "approved_paper",
        promoteLiveAutomatically: false,
      },
    })}\n`,
    "utf8",
  );
  await fs.writeFile(
    registryPath,
    `${JSON.stringify({ counters: { consecutiveReadyCycles: 3, consecutiveReadinessBlocks: 0 } })}\n`,
    "utf8",
  );
  const integrityResult = await runCapitalPaperAutoReview({
    repoRoot: tempRoot,
    evaluationPath,
    strategyPath,
    learningRegistryPath: registryPath,
    reviewReportPath,
    writeState: false,
  });
  if (integrityResult.status !== "approved_paper_integrity_blocked") {
    throw new Error(
      `source integrity breach must block approved_paper readback: ${JSON.stringify(integrityResult)}`,
    );
  }
  if (
    integrityResult.promotionBlocked !== true ||
    integrityResult.currentEvaluationApproved !== false
  ) {
    throw new Error(
      `source integrity block did not set safe blockers: ${JSON.stringify(integrityResult)}`,
    );
  }
}

await assertIntegrityBlocksAlreadyApproved();

const result = await runCapitalPaperAutoReview({ writeState: false });

const errors = [];

if (!result.safetyChecks?.liveStillBlocked) {
  errors.push(
    `safetyChecks.liveStillBlocked 不是 true（實際值：${result.safetyChecks?.liveStillBlocked}）— allowLiveTrading 安全鎖失效！`,
  );
}

if (!result.safetyChecks?.promoteLiveAutoStillFalse) {
  errors.push(
    `safetyChecks.promoteLiveAutoStillFalse 不是 true（實際值：${result.safetyChecks?.promoteLiveAutoStillFalse}）— promoteLiveAutomatically 安全鎖失效！`,
  );
}

if (!result.safetyChecks?.writeBrokerOrdersStillFalse) {
  errors.push(
    `safetyChecks.writeBrokerOrdersStillFalse 不是 true（實際值：${result.safetyChecks?.writeBrokerOrdersStillFalse}）— writeBrokerOrders 安全鎖失效！`,
  );
}

if (result.status === "already_approved" && result.evaluationRef?.recommendation === "reject") {
  errors.push("最新 evaluator 是 reject 時不可回報 already_approved，避免誤判為新通過。");
}

if (result.status === "approved_paper_current_rejected" && result.promoted) {
  errors.push("approved_paper_current_rejected 不可標示 promoted=true。");
}

if (result.status === "approved_paper_integrity_blocked" && result.promoted) {
  errors.push("approved_paper_integrity_blocked 不可標示 promoted=true。");
}

if (result.readOnly !== true || result.loginAttempted !== false) {
  errors.push("auto-review 必須 readOnly=true 且 loginAttempted=false。");
}

if (
  result.liveTradingEnabled !== false ||
  result.writeTradingEnabled !== false ||
  result.brokerOrderPathEnabled !== false
) {
  errors.push("auto-review 不可啟用 live/write/brokerOrderPath。");
}

if (result.status === "approved_paper_current_rejected") {
  if (result.currentEvaluationApproved !== false) {
    errors.push("approved_paper_current_rejected 必須標示 currentEvaluationApproved=false。");
  }
  if (result.promotionBlocked !== true) {
    errors.push("approved_paper_current_rejected 必須標示 promotionBlocked=true。");
  }
  if (!Array.isArray(result.failedRules) || result.failedRules.length === 0) {
    errors.push("approved_paper_current_rejected 必須保留 evaluator failedRules。");
  }
  if (!result.nextAction?.includes("禁止新晉升")) {
    errors.push("approved_paper_current_rejected 必須明確提示禁止新晉升。");
  }
  if (result.tuningPlan?.paperOnly !== true) {
    errors.push("approved_paper_current_rejected 必須輸出 paper-only tuningPlan。");
  }
  if (
    result.tuningPlan?.liveTradingEnabled !== false ||
    result.tuningPlan?.writeBrokerOrders !== false
  ) {
    errors.push("tuningPlan 不可啟用 liveTrading 或 broker writes。");
  }
  if (!Array.isArray(result.tuningPlan?.commands) || result.tuningPlan.commands.length === 0) {
    errors.push("tuningPlan 必須提供下一輪 paper-only 驗證命令。");
  }
  if (!Array.isArray(result.tuningPlan?.actions) || result.tuningPlan.actions.length === 0) {
    errors.push("tuningPlan 必須提供至少一個調參或樣本改善動作。");
  }
}

if (result.status === "approved_paper_integrity_blocked") {
  if (result.currentEvaluationApproved !== false) {
    errors.push("approved_paper_integrity_blocked 必須標示 currentEvaluationApproved=false。");
  }
  if (result.promotionBlocked !== true) {
    errors.push("approved_paper_integrity_blocked 必須標示 promotionBlocked=true。");
  }
  if (
    !Array.isArray(result.failedRules) ||
    !result.failedRules.includes("source_integrity_failed")
  ) {
    errors.push("approved_paper_integrity_blocked 必須保留 source_integrity_failed。");
  }
}

if (
  result.evaluationRef &&
  result.evaluationRef.recommendation !== "reject" &&
  result.evaluationRef.sourceIntegrityOk !== true
) {
  errors.push("非 reject evaluator 必須明確通過 sourceIntegrityOk。");
}

if (errors.length > 0) {
  throw new Error(
    `[check-capital-paper-auto-review] FAIL：安全檢查未通過。\n${errors.map((e) => `  - ${e}`).join("\n")}`,
  );
}

process.stdout.write(`CAPITAL_PAPER_AUTO_REVIEW_CHECK=OK status=${result.status}\n`);
