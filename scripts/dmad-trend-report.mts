/**
 * dmad-trend-report.mts — DMAD 辯論趨勢分析報告
 *
 * 用法：pnpm dmad:trend
 *
 * 功能：
 *   1. 讀取 reports/dmad-run-test-latest.json（最新報告）
 *   2. 讀取所有 reports/dmad-run-test-*.json 歷史報告
 *   3. 計算指標：avgConvergenceScore / trend / stoppedByDistribution / avgRounds / avgDurationMs
 *   4. 輸出 JSON 到 stdout
 *   5. 寫入 reports/dmad-trend-latest.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(scriptDir, "..");
const REPORTS_DIR = process.env.DMAD_TREND_REPORTS_DIR
  ? path.resolve(process.env.DMAD_TREND_REPORTS_DIR)
  : path.join(REPO_ROOT, "reports");
const LATEST_PATH = process.env.DMAD_TREND_LATEST_PATH
  ? path.resolve(process.env.DMAD_TREND_LATEST_PATH)
  : path.join(REPORTS_DIR, "dmad-run-test-latest.json");
const TREND_OUT = process.env.DMAD_TREND_OUT
  ? path.resolve(process.env.DMAD_TREND_OUT)
  : path.join(REPORTS_DIR, "dmad-trend-latest.json");

// ── 型別定義 ──────────────────────────────────────────────────────────────────

type StoppedByReason = "convergence" | "variance" | "max_rounds" | "timeout";

interface ReportEntry {
  runStatus?: string;
  convergenceScore?: number;
  totalRounds?: number;
  stoppedBy?: StoppedByReason;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  totalTimeoutMs?: number;
  aborted?: boolean;
  qualityStatus?: TrendQualityStatus;
  degradedReason?: string | null;
  hadCliError?: boolean;
  cliErrorSummary?: Partial<CliErrorSummary>;
  rounds?: Array<{ hadCliError?: boolean; cliErrors?: string[] }>;
  trajectoryScores?: { claude?: number; codex?: number; openclaw?: number };
}

interface CliErrorSummary {
  claudeMissing: number;
  claudeFailed: number;
  codexMissing: number;
  codexFailed: number;
}

type TrendQualityStatus = "pass" | "degraded_agents";
type TrendGateStatus = "pass" | "blocked_no_clean_reports";

interface NormalQualityGate {
  status: TrendGateStatus;
  reason: string | null;
}

interface TrendReport {
  generatedAt: string;
  reportCount: number;
  dedupedReportCount: number;
  invalidReportCount: number;
  completedReportCount: number;
  timeoutReportCount: number;
  cleanReportCount: number;
  degradedReportCount: number;
  timeoutRatePercent: number;
  avgConvergenceScore: number;
  cleanAvgConvergenceScore: number | null;
  degradedAvgConvergenceScore: number | null;
  /** Codex 補強：百分位數分析 */
  percentiles: { p50: number; p95: number };
  trend: "improving" | "stable" | "degrading";
  stoppedByDistribution: {
    convergence: number;
    variance: number;
    max_rounds: number;
    timeout: number;
  };
  /** Codex 補強：stoppedBy=convergence 比例（%） */
  convergenceRatePercent: number;
  avgRounds: number;
  avgDurationMs: number;
  qualityStatus: TrendQualityStatus;
  degradedReason: string | null;
  trendGateStatus: TrendGateStatus;
  normalQualityGate: NormalQualityGate;
  cliErrorRatePercent: number;
  cliErrorSummary: CliErrorSummary;
  /** Codex 補強：各代理在辯論中軌跡分最高的頻率 */
  agentLeadCount: { claude: number; codex: number; openclaw: number };
  latestResult: ReportEntry | null;
}

// ── 工具函數 ──────────────────────────────────────────────────────────────────

function readReportEntry(filePath: string): { entry: ReportEntry | null; invalid: boolean } {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return { entry: JSON.parse(raw) as ReportEntry, invalid: false };
  } catch {
    return { entry: null, invalid: true };
  }
}

function parseDurationMs(entry: ReportEntry): number {
  if (!entry.startedAt || !entry.completedAt) {
    return 0;
  }
  const start = new Date(entry.startedAt).getTime();
  const end = new Date(entry.completedAt).getTime();
  return Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(0, end - start);
}

function reportDedupKey(entry: ReportEntry): string {
  const id = (entry as Record<string, unknown>)["id"];
  if (typeof id === "string" && id.trim() !== "") {
    return `id:${id}`;
  }
  const stableParts = [
    entry.runStatus ?? "",
    entry.startedAt ?? "",
    entry.completedAt ?? "",
    entry.stoppedBy ?? "",
    entry.convergenceScore ?? "",
    entry.totalRounds ?? "",
    entry.qualityStatus ?? "",
    entry.degradedReason ?? "",
    entry.durationMs ?? "",
    entry.totalTimeoutMs ?? "",
  ];
  return `shape:${stableParts.join("|")}`;
}

function addReportEntry(
  entries: ReportEntry[],
  seenKeys: Set<string>,
  entry: ReportEntry,
): boolean {
  const key = reportDedupKey(entry);
  if (seenKeys.has(key)) {
    return false;
  }
  entries.push(entry);
  seenKeys.add(key);
  return true;
}

function calcTrend(scores: number[]): "improving" | "stable" | "degrading" {
  if (scores.length < 4) {
    return "stable";
  }
  const recent = scores.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const older = scores.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
  const diff = recent - older;
  if (diff > 0.03) {
    return "improving";
  }
  if (diff < -0.03) {
    return "degrading";
  }
  return "stable";
}

/** Codex 補強：計算百分位數（p = 0~1） */
function calcPercentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) {
    return 0;
  }
  const idx = Math.floor(p * (sortedArr.length - 1));
  return Number(sortedArr[Math.min(idx, sortedArr.length - 1)].toFixed(4));
}

/** Codex 補強：找出軌跡分最高的代理名稱 */
function leadAgent(entry: ReportEntry): "claude" | "codex" | "openclaw" | null {
  const ts = entry.trajectoryScores;
  if (!ts) {
    return null;
  }
  const scores: [string, number][] = [
    ["claude", ts.claude ?? 0],
    ["codex", ts.codex ?? 0],
    ["openclaw", ts.openclaw ?? 0],
  ];
  const sortedScores = scores.toSorted((a, b) => b[1] - a[1]);
  return (sortedScores[0]?.[0] ?? null) as "claude" | "codex" | "openclaw" | null;
}

function emptyCliErrorSummary(): CliErrorSummary {
  return { claudeMissing: 0, claudeFailed: 0, codexMissing: 0, codexFailed: 0 };
}

function degradedReasonFromCliSummary(summary: CliErrorSummary): string | null {
  const parts = [
    ["claude_missing", summary.claudeMissing],
    ["claude_failed", summary.claudeFailed],
    ["codex_missing", summary.codexMissing],
    ["codex_failed", summary.codexFailed],
  ]
    .filter(([, count]) => Number(count) > 0)
    .map(([code, count]) => `${code}=${count}`);
  return parts.length > 0 ? parts.join(",") : null;
}

function mergeCliErrorSummary(target: CliErrorSummary, source?: Partial<CliErrorSummary>) {
  if (!source) {
    return;
  }
  target.claudeMissing += source.claudeMissing ?? 0;
  target.claudeFailed += source.claudeFailed ?? 0;
  target.codexMissing += source.codexMissing ?? 0;
  target.codexFailed += source.codexFailed ?? 0;
}

function summarizeRoundCliErrors(entry: ReportEntry): CliErrorSummary {
  const summary = emptyCliErrorSummary();
  for (const round of entry.rounds ?? []) {
    const errors = new Set(round.cliErrors ?? []);
    if (errors.has("claude_missing")) {
      summary.claudeMissing++;
    }
    if (errors.has("claude_failed")) {
      summary.claudeFailed++;
    }
    if (errors.has("codex_missing")) {
      summary.codexMissing++;
    }
    if (errors.has("codex_failed")) {
      summary.codexFailed++;
    }
  }
  return summary;
}

function hasCliErrorSummary(summary?: Partial<CliErrorSummary>): boolean {
  if (!summary) {
    return false;
  }
  return (
    (summary.claudeMissing ?? 0) > 0 ||
    (summary.claudeFailed ?? 0) > 0 ||
    (summary.codexMissing ?? 0) > 0 ||
    (summary.codexFailed ?? 0) > 0
  );
}

function effectiveCliErrorSummary(entry: ReportEntry): CliErrorSummary {
  const summary = emptyCliErrorSummary();
  if (hasCliErrorSummary(entry.cliErrorSummary)) {
    mergeCliErrorSummary(summary, entry.cliErrorSummary);
    return summary;
  }
  mergeCliErrorSummary(summary, summarizeRoundCliErrors(entry));
  return summary;
}

function entryIsTimeoutReport(entry: ReportEntry): boolean {
  return (
    entry.runStatus === "timeout" ||
    entry.stoppedBy === "timeout" ||
    entry.degradedReason === "run_timeout" ||
    entry.totalTimeoutMs !== undefined
  );
}

function entryHasCliError(entry: ReportEntry): boolean {
  if (entryIsTimeoutReport(entry)) {
    return true;
  }
  if (entry.hadCliError) {
    return true;
  }
  return Object.values(effectiveCliErrorSummary(entry)).some((value) => value > 0);
}

function entryQualityStatus(entry: ReportEntry): TrendQualityStatus {
  if (entryIsTimeoutReport(entry)) {
    return "degraded_agents";
  }
  return entry.qualityStatus ?? (entryHasCliError(entry) ? "degraded_agents" : "pass");
}

function avgScore(entries: ReportEntry[]): number | null {
  if (entries.length === 0) {
    return null;
  }
  const sum = entries.reduce((total, entry) => total + (entry.convergenceScore ?? 0), 0);
  return Number((sum / entries.length).toFixed(4));
}

function normalQualityGate(cleanReportCount: number): NormalQualityGate {
  if (cleanReportCount > 0) {
    return { status: "pass", reason: null };
  }
  return { status: "blocked_no_clean_reports", reason: "cleanReportCount=0" };
}

// ── 主程式 ──────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  // 1. 讀取所有歷史報告；只用 Node 內建 fs，避免為趨勢報告新增 runtime 依賴。
  const allFiles = fs.existsSync(REPORTS_DIR) ? fs.readdirSync(REPORTS_DIR) : [];
  const historyPaths = allFiles
    .filter((f) => f.startsWith("dmad-run-test-") && f.endsWith(".json"))
    .map((f) => path.join(REPORTS_DIR, f))
    .filter((p) => path.resolve(p) !== path.resolve(LATEST_PATH));

  // 2. 整合最新報告
  const latestRead = fs.existsSync(LATEST_PATH)
    ? readReportEntry(LATEST_PATH)
    : { entry: null, invalid: false };
  const latestEntry = latestRead.entry;
  const allEntries: ReportEntry[] = [];
  const seenReportKeys = new Set<string>();
  let dedupedReportCount = 0;
  let invalidReportCount = latestRead.invalid ? 1 : 0;

  // 歷史報告（按時間排序）
  for (const p of historyPaths) {
    const { entry, invalid } = readReportEntry(p);
    if (invalid) {
      invalidReportCount++;
    }
    if (entry) {
      if (!addReportEntry(allEntries, seenReportKeys, entry)) {
        dedupedReportCount++;
      }
    }
  }

  // 若 latest 與歷史報告同內容或同 id，只保留一份；無 id 的獨立 latest 仍會補入。
  if (latestEntry) {
    if (!addReportEntry(allEntries, seenReportKeys, latestEntry)) {
      dedupedReportCount++;
    }
  }

  // 按 startedAt 排序（舊 → 新）
  allEntries.sort((a, b) => {
    const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return ta - tb;
  });

  // 3. 計算指標
  const reportCount = allEntries.length;
  const timeoutEntries = allEntries.filter(entryIsTimeoutReport);
  const completedEntries = allEntries.filter((entry) => !entryIsTimeoutReport(entry));
  const completedReportCount = completedEntries.length;
  const timeoutReportCount = timeoutEntries.length;
  const timeoutRatePercent =
    reportCount > 0 ? Math.round((timeoutReportCount / reportCount) * 100) : 0;
  const cleanEntries = completedEntries.filter((entry) => entryQualityStatus(entry) === "pass");
  const degradedEntries = completedEntries.filter(
    (entry) => entryQualityStatus(entry) === "degraded_agents",
  );
  const cleanReportCount = cleanEntries.length;
  const degradedReportCount = degradedEntries.length;

  const convergenceScores = completedEntries.map((e) => e.convergenceScore ?? 0);
  const avgConvergenceScore =
    completedReportCount > 0
      ? Number((convergenceScores.reduce((a, b) => a + b, 0) / completedReportCount).toFixed(4))
      : 0;
  const cleanAvgConvergenceScore = avgScore(cleanEntries);
  const degradedAvgConvergenceScore = avgScore(degradedEntries);

  // Codex 補強：百分位數（對排序後陣列計算 p50 / p95）
  const sortedScores = convergenceScores.toSorted((a, b) => a - b);
  const percentiles = {
    p50: calcPercentile(sortedScores, 0.5),
    p95: calcPercentile(sortedScores, 0.95),
  };

  const trend = calcTrend(convergenceScores);

  const stoppedByDistribution = { convergence: 0, variance: 0, max_rounds: 0, timeout: 0 };
  for (const e of allEntries) {
    const sb = entryIsTimeoutReport(e) ? "timeout" : (e.stoppedBy ?? "max_rounds");
    stoppedByDistribution[sb] = (stoppedByDistribution[sb] ?? 0) + 1;
  }

  // Codex 補強：stoppedBy=convergence 的比例
  const convergenceRatePercent =
    completedReportCount > 0
      ? Math.round((stoppedByDistribution.convergence / completedReportCount) * 100)
      : 0;

  const roundValues = completedEntries.map((e) => e.totalRounds ?? 0);
  const avgRounds =
    completedReportCount > 0
      ? Number((roundValues.reduce((a, b) => a + b, 0) / completedReportCount).toFixed(2))
      : 0;

  const durationValues = completedEntries.map(parseDurationMs);
  const avgDurationMs =
    completedReportCount > 0
      ? Math.round(durationValues.reduce((a, b) => a + b, 0) / completedReportCount)
      : 0;

  const cliErrorSummary = emptyCliErrorSummary();
  let cliErrorEntryCount = 0;
  for (const e of allEntries) {
    if (entryHasCliError(e)) {
      cliErrorEntryCount++;
    }
    mergeCliErrorSummary(cliErrorSummary, effectiveCliErrorSummary(e));
  }
  const cliErrorRatePercent =
    reportCount > 0 ? Math.round((cliErrorEntryCount / reportCount) * 100) : 0;
  const cliDegradedReason = degradedReasonFromCliSummary(cliErrorSummary);
  const timeoutDegradedReason = timeoutReportCount > 0 ? `run_timeout=${timeoutReportCount}` : null;
  const degradedReason =
    [cliDegradedReason, timeoutDegradedReason].filter(Boolean).join(",") || null;
  const qualityStatus: TrendQualityStatus =
    cliErrorRatePercent > 0 || degradedReportCount > 0 || timeoutReportCount > 0
      ? "degraded_agents"
      : "pass";
  const qualityGate = normalQualityGate(cleanReportCount);
  const trendGateStatus = qualityGate.status;

  // Codex 補強：各代理在各報告中軌跡分最高的計數
  const agentLeadCount = { claude: 0, codex: 0, openclaw: 0 };
  for (const e of completedEntries) {
    const leader = leadAgent(e);
    if (leader) {
      agentLeadCount[leader]++;
    }
  }

  // 最新一次摘要（去掉 rounds 詳細內容節省空間）
  const latestSummary: ReportEntry | null = latestEntry
    ? {
        runStatus: latestEntry.runStatus,
        convergenceScore: latestEntry.convergenceScore,
        totalRounds: latestEntry.totalRounds,
        stoppedBy: latestEntry.stoppedBy,
        startedAt: latestEntry.startedAt,
        completedAt: latestEntry.completedAt,
        durationMs: latestEntry.durationMs,
        totalTimeoutMs: latestEntry.totalTimeoutMs,
        aborted: latestEntry.aborted,
        qualityStatus: latestEntry.qualityStatus,
        degradedReason: latestEntry.degradedReason,
        hadCliError: latestEntry.hadCliError,
        cliErrorSummary: latestEntry.cliErrorSummary,
        trajectoryScores: latestEntry.trajectoryScores,
      }
    : null;

  const report: TrendReport = {
    generatedAt: new Date().toISOString(),
    reportCount,
    dedupedReportCount,
    invalidReportCount,
    completedReportCount,
    timeoutReportCount,
    cleanReportCount,
    degradedReportCount,
    timeoutRatePercent,
    avgConvergenceScore,
    cleanAvgConvergenceScore,
    degradedAvgConvergenceScore,
    percentiles,
    trend,
    stoppedByDistribution,
    convergenceRatePercent,
    avgRounds,
    avgDurationMs,
    qualityStatus,
    degradedReason,
    trendGateStatus,
    normalQualityGate: qualityGate,
    cliErrorRatePercent,
    cliErrorSummary,
    agentLeadCount,
    latestResult: latestSummary,
  };

  // 4. 輸出到 stdout
  const output = JSON.stringify(report, null, 2);
  process.stdout.write(output + "\n");

  // 5. 寫入 dmad-trend-latest.json
  fs.writeFileSync(TREND_OUT, output, "utf-8");
  console.error(`[dmad-trend-report] 趨勢報告寫入：${TREND_OUT}`);

  console.error(
    `[dmad-trend-report] 共分析 ${reportCount} 份報告（deduped=${dedupedReportCount}, invalid=${invalidReportCount}, completed=${completedReportCount}, clean=${cleanReportCount}, degraded=${degradedReportCount}, timeout=${timeoutReportCount}）`,
  );
  console.error(
    `  avgConvergenceScore = ${avgConvergenceScore}  clean=${cleanAvgConvergenceScore ?? "n/a"}  degraded=${degradedAvgConvergenceScore ?? "n/a"}  (p50=${percentiles.p50}  p95=${percentiles.p95})`,
  );
  console.error(
    `  trend = ${trend}  convergenceRate = ${convergenceRatePercent}%  timeoutRate = ${timeoutRatePercent}%`,
  );
  console.error(
    `  trendGateStatus = ${trendGateStatus}${qualityGate.reason ? `  reason=${qualityGate.reason}` : ""}`,
  );
  console.error(`  avgRounds = ${avgRounds}  avgDurationMs = ${avgDurationMs}ms`);
  console.error(
    `  qualityStatus = ${qualityStatus}${degradedReason ? `  degradedReason=${degradedReason}` : ""}`,
  );
  console.error(
    `  cliErrorRate = ${cliErrorRatePercent}%  cliErrorSummary=${JSON.stringify(cliErrorSummary)}`,
  );
  console.error(`  stoppedBy: ${JSON.stringify(stoppedByDistribution)}`);
  console.error(
    `  agentLeadCount: claude=${agentLeadCount.claude}  codex=${agentLeadCount.codex}  openclaw=${agentLeadCount.openclaw}`,
  );
}

main().catch((err) => {
  console.error("[dmad-trend-report] 致命錯誤：", err);
  process.exitCode = 1;
});
