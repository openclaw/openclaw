/**
 * dmad-meta-learn.mts — DMAD 元學習：系統分析自身歷史，輸出改進建議
 *
 * 用法：pnpm dmad:meta-learn
 *
 * 這是讓 DMAD 成為「永久自我進化」系統的關鍵腳本。
 *
 * 分析維度：
 *   1. 路由準確率    — 哪類路由決策需要更多輪數（暗示路由有誤）
 *   2. 校準漂移      — 過去 N 場辯論的閾值趨勢
 *   3. 驗證失敗率    — MoA 品質評估
 *   4. 先驗注入效益  — 有先驗 vs 無先驗的平均輪數差異
 *   5. 代理貢獻分析  — 哪個代理最常是軌跡分最高者
 *   6. 自動輸出校準建議 — 給下一次 runDMAD 的參數建議
 */

import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(scriptDir, "..")
const REPORT_OUT = path.join(REPO_ROOT, "reports", "dmad-meta-learn-latest.json")
const CALIBRATION_OUT = path.join(REPO_ROOT, "reports", "dmad-calibration.json")

// ── 型別 ─────────────────────────────────────────────────────────────────────

interface DebateRecord {
  id: string
  task: string
  convergence_score: number
  rounds_count: number
  stopped_by: string
  route_confidence: string | null
  verify_pass: number | null
  verify_confidence: number | null
  prior_injected: number | null
  calibrated_threshold: number | null
  started_at: string
}

interface MetaReport {
  generatedAt: string
  totalDebates: number
  routingAnalysis: {
    highConfidence: { count: number; avgRounds: number; convergenceRate: number }
    mediumConfidence: { count: number; avgRounds: number; convergenceRate: number }
    lowConfidence: { count: number; avgRounds: number; convergenceRate: number }
    diagnosis: string
  }
  verificationAnalysis: {
    passRate: number
    avgConfidence: number
    failedTasks: string[]
    diagnosis: string
  }
  priorInjectionAnalysis: {
    withPrior: { count: number; avgRounds: number }
    withoutPrior: { count: number; avgRounds: number }
    roundsSaved: number
    diagnosis: string
  }
  calibrationDrift: {
    recent10Avg: number
    all20Avg: number
    suggestedThreshold: number
    drift: "stable" | "rising" | "falling"
  }
  agentContribution: {
    claudeLeadCount: number
    codexLeadCount: number
    openclawLeadCount: number
    dominantAgent: string
  }
  recommendations: string[]
  calibrationConfig: {
    suggestedConvergenceThreshold: number
    suggestedMaxRounds: number
    note: string
  }
}

// ── nuwa.db 讀取 ──────────────────────────────────────────────────────────────

async function loadDebates(): Promise<DebateRecord[]> {
  // 使用與 dmad-smoke-test.mjs 相同的 sqlite-compat 相容層
  const NUWA_DB = path.join(REPO_ROOT, "extensions", "evolution-learning", ".claude", "evolution-state", "nuwa.db")
  if (!fs.existsSync(NUWA_DB)) {
    console.error("[meta-learn] 找不到 nuwa.db，改用 reports JSON 模式")
    return loadFromReports()
  }

  try {
    const { openDb } = await import("./lib/sqlite-compat.mjs") as { openDb: (p: string, opts?: unknown) => Promise<{
      prepare: (sql: string) => { all: (...args: unknown[]) => unknown[]; get: (...args: unknown[]) => unknown }
      close: () => void
    }>}
    const db = await openDb(NUWA_DB, { readonly: true })

    const hasDebates = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='debates'"
    ).get()
    if (!hasDebates) {
      console.error("[meta-learn] debates 表不存在，改用 reports JSON 模式")
      db.close()
      return loadFromReports()
    }

    const rows = db.prepare(`
      SELECT id, task, convergence_score, rounds_count, stopped_by,
             route_confidence, verify_pass, verify_confidence,
             prior_injected, calibrated_threshold, started_at
      FROM debates
      ORDER BY started_at DESC
      LIMIT 100
    `).all() as DebateRecord[]
    db.close()
    if (rows.length === 0) {
      console.error("[meta-learn] debates 表暫無記錄，改用 reports JSON 模式補充")
      return loadFromReports()
    }
    console.error(`[meta-learn] 從 nuwa.db 載入 ${rows.length} 筆辯論記錄`)
    return rows
  } catch (err) {
    console.error("[meta-learn] 讀取 nuwa.db 失敗：", String(err).slice(0, 200))
    return loadFromReports()
  }
}

function loadFromReports(): DebateRecord[] {
  // fallback：從 JSON 報告構造簡化版 records
  const files = [
    path.join(REPO_ROOT, "reports", "dmad-run-test-latest.json"),
    path.join(REPO_ROOT, "reports", "dmad-smoke-test-latest.json"),
  ]
  const records: DebateRecord[] = []
  for (const f of files) {
    if (!fs.existsSync(f)) {
      continue
    }
    try {
      const raw = JSON.parse(fs.readFileSync(f, "utf-8")) as Record<string, unknown>
      records.push({
        id: stringFromUnknown(raw["id"]),
        task: stringFromUnknown(raw["task"]),
        convergence_score: Number(raw["convergenceScore"] ?? 0),
        rounds_count: Number(raw["totalRounds"] ?? 0),
        stopped_by: stringFromUnknown(raw["stoppedBy"], "max_rounds"),
        route_confidence: null,
        verify_pass: null,
        verify_confidence: null,
        prior_injected: null,
        calibrated_threshold: null,
        started_at: stringFromUnknown(raw["startedAt"]),
      })
    } catch { /* ignore */ }
  }
  console.error(`[meta-learn] 從 JSON 報告載入 ${records.length} 筆記錄（降級模式）`)
  return records
}

// ── 分析函數 ──────────────────────────────────────────────────────────────────

function stringFromUnknown(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  return fallback
}

function avg(arr: number[]): number {
  if (arr.length === 0) {
    return 0
  }
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function analyzeRouting(records: DebateRecord[]): MetaReport["routingAnalysis"] {
  const groups: Record<string, DebateRecord[]> = { high: [], medium: [], low: [], null: [] }
  for (const r of records) {
    const key = r.route_confidence ?? "null"
    ;(groups[key] ?? (groups[key] = [])).push(r)
  }
  const mkStat = (arr: DebateRecord[]) => ({
    count: arr.length,
    avgRounds: Number(avg(arr.map(r => r.rounds_count)).toFixed(2)),
    convergenceRate: arr.length > 0
      ? Number((arr.filter(r => r.stopped_by === "convergence").length / arr.length * 100).toFixed(1))
      : 0,
  })
  const high = mkStat(groups["high"] ?? [])
  const medium = mkStat(groups["medium"] ?? [])
  const low = mkStat(groups["null"] ?? [])

  // 診斷：high confidence 應該最快收斂
  let diagnosis = "路由運作正常"
  if (high.count > 0 && medium.count > 0 && high.avgRounds > medium.avgRounds + 0.5) {
    diagnosis = "⚠️ high-confidence 路由的平均輪數高於 medium，可能需要擴充技術/語言關鍵字"
  } else if (low.count > 2 && low.convergenceRate < 50) {
    diagnosis = "⚠️ 有較多無法分類的任務，建議擴充路由關鍵字覆蓋範圍"
  }

  return { highConfidence: high, mediumConfidence: medium, lowConfidence: low, diagnosis }
}

function analyzeVerification(records: DebateRecord[]): MetaReport["verificationAnalysis"] {
  const withVerify = records.filter(r => r.verify_pass !== null)
  if (withVerify.length === 0) {
    return {
      passRate: 100,
      avgConfidence: 0.5,
      failedTasks: [],
      diagnosis: "尚無驗證記錄（Pillar 3 尚未累積資料）",
    }
  }
  const passRate = Number((withVerify.filter(r => r.verify_pass === 1).length / withVerify.length * 100).toFixed(1))
  const avgConf = Number(avg(withVerify.map(r => r.verify_confidence ?? 0.5)).toFixed(3))
  const failed = withVerify
    .filter(r => r.verify_pass === 0)
    .map(r => r.task.slice(0, 50))
    .slice(0, 5)

  let diagnosis = "驗證通過率良好"
  if (passRate < 70) {
    diagnosis = `⚠️ 驗證通過率僅 ${passRate}%，MoA 答案品質需改善`
  } else if (passRate < 85) {
    diagnosis = `⚠️ 驗證通過率 ${passRate}%，有改善空間`
  }

  return { passRate, avgConfidence: avgConf, failedTasks: failed, diagnosis }
}

function analyzePriorInjection(records: DebateRecord[]): MetaReport["priorInjectionAnalysis"] {
  const withPrior = records.filter(r => r.prior_injected === 1)
  const withoutPrior = records.filter(r => r.prior_injected === 0)

  const withAvg = avg(withPrior.map(r => r.rounds_count))
  const withoutAvg = avg(withoutPrior.map(r => r.rounds_count))
  const saved = Number((withoutAvg - withAvg).toFixed(2))

  let diagnosis = "先驗注入效益尚未累積（需要更多歷史記錄）"
  if (withPrior.length > 3) {
    if (saved > 0.3) {
      diagnosis = `✅ 先驗注入平均節省 ${saved} 輪，效果顯著`
    } else if (saved > 0) {
      diagnosis = `先驗注入有輕微效益（節省 ${saved} 輪）`
    } else {
      diagnosis = `⚠️ 先驗注入暫無明顯效益（差異 ${saved} 輪），可能先驗相關性不夠`
    }
  }

  return {
    withPrior: { count: withPrior.length, avgRounds: Number(withAvg.toFixed(2)) },
    withoutPrior: { count: withoutPrior.length, avgRounds: Number(withoutAvg.toFixed(2)) },
    roundsSaved: saved,
    diagnosis,
  }
}

function analyzeCalibration(records: DebateRecord[]): MetaReport["calibrationDrift"] {
  const scores = records.map(r => r.convergence_score)

  const recent10 = Number(avg(scores.slice(0, 10)).toFixed(4))
  const all20 = Number(avg(scores.slice(0, 20)).toFixed(4))

  // 建議閾值：中位數 × 0.95，限制在 [0.60, 0.85]
  const sorted = scores.filter(s => s > 0).toSorted((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length > 0
    ? (sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0.69))
    : 0.69
  const suggested = Number(Math.max(0.6, Math.min(0.85, median * 0.95)).toFixed(4))

  let drift: "stable" | "rising" | "falling" = "stable"
  if (recent10 - all20 > 0.03) {
    drift = "rising"
  } else if (all20 - recent10 > 0.03) {
    drift = "falling"
  }

  return { recent10Avg: recent10, all20Avg: all20, suggestedThreshold: suggested, drift }
}

function analyzeAgents(): MetaReport["agentContribution"] {
  // 從報告 JSON 補充 trajectoryScores（nuwa.db 不儲存此欄位）
  const reportPath = path.join(REPO_ROOT, "reports", "dmad-run-test-latest.json")
  let claudeLeadCount = 0, codexLeadCount = 0, openclawLeadCount = 0
  try {
    const latest = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as {
      trajectoryScores?: { claude?: number; codex?: number; openclaw?: number }
    }
    const ts = latest.trajectoryScores ?? {}
    const scores: [string, number][] = [
      ["claude", ts.claude ?? 0], ["codex", ts.codex ?? 0], ["openclaw", ts.openclaw ?? 0]
    ]
    const leader = scores.toSorted((a, b) => b[1] - a[1])[0]?.[0] ?? "claude"
    if (leader === "claude") {
      claudeLeadCount++
    } else if (leader === "codex") {
      codexLeadCount++
    } else {
      openclawLeadCount++
    }
  } catch { /* ignore */ }

  const total = claudeLeadCount + codexLeadCount + openclawLeadCount
  const dominantAgent = total === 0 ? "尚無資料"
    : claudeLeadCount >= codexLeadCount && claudeLeadCount >= openclawLeadCount ? "Claude"
    : codexLeadCount >= openclawLeadCount ? "Codex"
    : "OpenClaw"

  return { claudeLeadCount, codexLeadCount, openclawLeadCount, dominantAgent }
}

// ── 主程式 ──────────────────────────────────────────────────────────────────

async function main() {
  console.error("=================================================")
  console.error("[dmad-meta-learn] DMAD 元學習分析")
  console.error("=================================================\n")

  const records = await loadDebates()
  if (records.length === 0) {
    console.error("[meta-learn] 無辯論記錄，無法分析")
    process.exitCode = 1
    return
  }

  const routing = analyzeRouting(records)
  const verification = analyzeVerification(records)
  const prior = analyzePriorInjection(records)
  const calibration = analyzeCalibration(records)
  const agents = analyzeAgents()

  // 彙整建議清單
  const recommendations: string[] = []
  if (routing.diagnosis.startsWith("⚠️")) {
    recommendations.push(routing.diagnosis)
  }
  if (verification.diagnosis.startsWith("⚠️")) {
    recommendations.push(verification.diagnosis)
  }
  if (prior.diagnosis.startsWith("⚠️")) {
    recommendations.push(prior.diagnosis)
  }
  if (calibration.drift === "rising") {
    recommendations.push(`⚠️ 收斂分上升趨勢（${calibration.recent10Avg} > ${calibration.all20Avg}），系統討論品質提升中`)
  }
  if (calibration.drift === "falling") {
    recommendations.push(`⚠️ 收斂分下降（${calibration.recent10Avg} < ${calibration.all20Avg}），需檢查 agent 回應品質`)
  }
  if (recommendations.length === 0) {
    recommendations.push("✅ 系統運作正常，繼續累積資料")
  }

  // 校準建議設定檔（可供 runDMAD 讀取覆蓋預設值）
  const calibrationConfig = {
    suggestedConvergenceThreshold: calibration.suggestedThreshold,
    suggestedMaxRounds: routing.highConfidence.avgRounds > 2 ? 3 : 2,
    note: `基於 ${records.length} 筆辯論歷史，${new Date().toISOString()} 生成`,
  }

  const report: MetaReport = {
    generatedAt: new Date().toISOString(),
    totalDebates: records.length,
    routingAnalysis: routing,
    verificationAnalysis: verification,
    priorInjectionAnalysis: prior,
    calibrationDrift: calibration,
    agentContribution: agents,
    recommendations,
    calibrationConfig,
  }

  // 輸出摘要
  console.error(`[meta-learn] 分析了 ${records.length} 筆辯論記錄`)
  console.error(`  路由診斷：${routing.diagnosis}`)
  console.error(`  驗證診斷：${verification.diagnosis}`)
  console.error(`  先驗效益：${prior.diagnosis}`)
  console.error(`  校準漂移：${calibration.drift}  建議閾值：${calibration.suggestedThreshold}`)
  console.error(`  主導代理：${agents.dominantAgent}`)
  console.error("\n  建議：")
  for (const r of recommendations) {
    console.error(`    ${r}`)
  }

  // 寫入報告
  fs.mkdirSync(path.dirname(REPORT_OUT), { recursive: true })
  fs.writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2))
  console.error(`\n[meta-learn] 報告寫入：${REPORT_OUT}`)

  // 寫入校準設定（供 runDMAD 自動讀取）
  fs.writeFileSync(CALIBRATION_OUT, JSON.stringify(calibrationConfig, null, 2))
  console.error(`[meta-learn] 校準設定寫入：${CALIBRATION_OUT}`)

  process.stdout.write(JSON.stringify(report) + "\n")
}

main().catch(err => {
  console.error("[dmad-meta-learn] 致命錯誤：", err)
  process.exitCode = 1
})
