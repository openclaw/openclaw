import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCapitalPaperErrorRepair } from "./openclaw-capital-paper-error-repair.mjs";

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// 建立最小 fixture：blocked_readiness + 報價過期
async function writeMinimalFixture(repoRoot) {
  const tradingDir = path.join(repoRoot, ".openclaw", "trading");
  await writeJson(path.join(tradingDir, "capital-paper-automation-loop-latest.json"), {
    schema: "openclaw.capital.paper-automation-loop.v1",
    status: "blocked_readiness",
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    readiness: {
      quoteAgeSeconds: 120,
      maxQuoteAgeSeconds: 2,
    },
  });
  await writeJson(path.join(tradingDir, "capital-paper-auto-review-latest.json"), {
    schema: "openclaw.capital.paper-auto-review.v1",
    status: "approved_paper_current_rejected",
    promotionBlocked: true,
    currentEvaluationApproved: false,
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    brokerOrderPathEnabled: false,
    evaluationRef: {
      recommendation: "reject",
      passCount: 2,
      ruleCount: 6,
      sourceIntegrityOk: true,
    },
    failedRules: ["avg_pnl_ticks", "monte_carlo_positive_rate"],
  });
}

const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capital-error-repair-"));
await writeMinimalFixture(repoRoot);

const result = await runCapitalPaperErrorRepair({ repoRoot, dryRun: true });

// 驗證安全檢查全部通過
if (!result.safetyChecks.noLoginAttempted) {
  throw new Error(
    `安全檢查失敗：noLoginAttempted 應為 true，實際值: ${result.safetyChecks.noLoginAttempted}`,
  );
}
if (!result.safetyChecks.noLiveTradingEnabled) {
  throw new Error(
    `安全檢查失敗：noLiveTradingEnabled 應為 true，實際值: ${result.safetyChecks.noLiveTradingEnabled}`,
  );
}
if (!result.safetyChecks.noWriteTradingEnabled) {
  throw new Error(
    `安全檢查失敗：noWriteTradingEnabled 應為 true，實際值: ${result.safetyChecks.noWriteTradingEnabled}`,
  );
}
if (!result.safetyChecks.noBrokerWriteEnabled) {
  throw new Error(
    `安全檢查失敗：noBrokerWriteEnabled 應為 true，實際值: ${result.safetyChecks.noBrokerWriteEnabled}`,
  );
}
if (!result.safetyChecks.readOnlyRepairOnly) {
  throw new Error(
    `安全檢查失敗：readOnlyRepairOnly 應為 true，實際值: ${result.safetyChecks.readOnlyRepairOnly}`,
  );
}

// 驗證 repairStatus 不是 safety_violation
if (result.repairStatus === "safety_violation") {
  throw new Error(`修復狀態不應為 safety_violation：${JSON.stringify(result.safetyChecks)}`);
}

// 驗證 blocked_readiness + 報價過期的修復路徑
if (result.loopStatus !== "blocked_readiness") {
  throw new Error(`loopStatus 應為 blocked_readiness，實際值: ${result.loopStatus}`);
}
if (result.repairStatus !== "awaiting_quote") {
  throw new Error(
    `repairStatus 應為 awaiting_quote（報價過期情境），實際值: ${result.repairStatus}`,
  );
}
if (result.repairAction !== "await_fresh_quote") {
  throw new Error(`repairAction 應為 await_fresh_quote，實際值: ${result.repairAction}`);
}
if (
  result.readOnly !== true ||
  result.loginAttempted !== false ||
  result.liveTradingEnabled !== false ||
  result.writeTradingEnabled !== false ||
  result.brokerOrderPathEnabled !== false
) {
  throw new Error(
    `輸出安全欄位不完整或不安全：${JSON.stringify({
      readOnly: result.readOnly,
      loginAttempted: result.loginAttempted,
      liveTradingEnabled: result.liveTradingEnabled,
      writeTradingEnabled: result.writeTradingEnabled,
      brokerOrderPathEnabled: result.brokerOrderPathEnabled,
    })}`,
  );
}
if (result.paperReview?.promotionBlocked !== true) {
  throw new Error(
    `paperReview.promotionBlocked 應為 true，實際值: ${result.paperReview?.promotionBlocked}`,
  );
}
if (result.paperReview?.sourceIntegrityOk !== true) {
  throw new Error(
    `paperReview.sourceIntegrityOk 應為 true，實際值: ${result.paperReview?.sourceIntegrityOk}`,
  );
}
if (result.currentEvaluationApproved !== false) {
  throw new Error(
    `currentEvaluationApproved 應為 false，實際值: ${result.currentEvaluationApproved}`,
  );
}
if (!String(result.nextAction ?? "").includes("paper-only")) {
  throw new Error(`nextAction 必須明確要求 paper-only，實際值: ${result.nextAction}`);
}

// 確認 dryRun 模式下未寫入任何輸出檔案
const outputPath = path.join(
  repoRoot,
  ".openclaw",
  "trading",
  "capital-paper-error-repair-latest.json",
);
let outputExists = false;
try {
  await fs.access(outputPath);
  outputExists = true;
} catch {
  outputExists = false;
}
if (outputExists) {
  throw new Error("dryRun=true 時不應寫入 outputPath 檔案");
}

const writeResult = await runCapitalPaperErrorRepair({ repoRoot, dryRun: false });
if (writeResult.repairStatus !== "awaiting_quote") {
  throw new Error(
    `write 模式 repairStatus 應為 awaiting_quote，實際值: ${writeResult.repairStatus}`,
  );
}

const writtenText = await fs.readFile(outputPath, "utf8");
const written = JSON.parse(writtenText);
if (written.paperReview?.failedRuleCount !== 2) {
  throw new Error(
    `寫入報告應保留 auto-review failedRuleCount=2，實際值: ${written.paperReview?.failedRuleCount}`,
  );
}
if (written.paperReview?.sourceIntegrityOk !== true) {
  throw new Error(
    `寫入報告應保留 auto-review sourceIntegrityOk=true，實際值: ${written.paperReview?.sourceIntegrityOk}`,
  );
}

const shaPath = `${outputPath}.sha256`;
const shaText = await fs.readFile(shaPath, "ascii");
if (!/^[0-9A-F]{64}\n?$/.test(shaText)) {
  throw new Error(`SHA256 sidecar 格式錯誤：${shaText}`);
}

process.stdout.write("CAPITAL_PAPER_ERROR_REPAIR_CHECK=OK\n");
