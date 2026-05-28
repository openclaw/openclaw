/**
 * hermes-nuwa-bridge.mts — Hermes 學習 → nuwa.db 橋接
 *
 * 把 reports/hermes-agent/state/learning-state.json 的 success_patterns
 * 同步寫入 nuwa.db patterns 表，讓 DMAD 先驗注入（Pillar 1）可以讀取
 * Hermes 積累的受控任務成功知識。
 *
 * 用法：pnpm hermes:nuwa-bridge
 * 建議：每日由 cron 呼叫，或在 learning-state.json 更新後手動執行
 */

import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, "..")

const LEARNING_STATE_PATH = path.join(
  REPO_ROOT,
  "reports",
  "hermes-agent",
  "state",
  "learning-state.json",
)
const NUWA_DB_PATH = path.join(
  REPO_ROOT,
  "extensions",
  "evolution-learning",
  ".claude",
  "evolution-state",
  "nuwa.db",
)
const BRIDGE_REPORT_PATH = path.join(REPO_ROOT, "reports", "hermes-nuwa-bridge-latest.json")

// ── 類型定義 ──────────────────────────────────────────────────────────────────

interface LearningRecord {
  trace_id: string
  status: "success" | "failure"
  summary: string
  created_at: string
  tags: string[]
}

interface LearningState {
  version: 1
  success_patterns: LearningRecord[]
  failure_patterns: LearningRecord[]
  updated_at: string
}

interface BridgeReport {
  generatedAt: string
  sourceRecords: number
  newPatternsInserted: number
  updatedPatterns: number
  skippedPatterns: number
  errors: string[]
  status: "ok" | "no_source" | "no_db" | "error"
}

// ── slug 生成：從任務 ID 轉換為 nuwa.db 相容的 slug ─────────────────────────

function taskIdToSlug(taskId: string): string {
  // 將底線/連字號標準化，加上 hermes- 前綴避免衝突
  return `hermes-${taskId.replace(/_/g, "-").toLowerCase().slice(0, 48)}`
}

// ── 從 summary 擷取任務 ID ───────────────────────────────────────────────────

function extractTaskId(record: LearningRecord): string {
  // tags 通常包含任務 ID，例如 ['controlled-task-runner', 'dmad-smoke-test', 'pass']
  const taskTag = record.tags.find(
    (t) => t !== "controlled-task-runner" && t !== "pass" && t !== "fail",
  )
  return taskTag ?? "unknown-task"
}

// ── 主程式 ───────────────────────────────────────────────────────────────────

async function main() {
  console.error("=================================================")
  console.error("[hermes-nuwa-bridge] Hermes → nuwa.db 橋接")
  console.error("=================================================\n")

  const report: BridgeReport = {
    generatedAt: new Date().toISOString(),
    sourceRecords: 0,
    newPatternsInserted: 0,
    updatedPatterns: 0,
    skippedPatterns: 0,
    errors: [],
    status: "ok",
  }

  // ── 1. 讀取 learning-state.json ───────────────────────────────────────────
  if (!fs.existsSync(LEARNING_STATE_PATH)) {
    console.error("[bridge] learning-state.json 不存在，尚無 Hermes 學習資料")
    report.status = "no_source"
    writeReport(report)
    process.exitCode = 0
    return
  }

  let learningState: LearningState
  try {
    learningState = JSON.parse(fs.readFileSync(LEARNING_STATE_PATH, "utf-8")) as LearningState
  } catch (err) {
    report.status = "error"
    report.errors.push(`讀取 learning-state.json 失敗: ${String(err).slice(0, 200)}`)
    writeReport(report)
    process.exitCode = 1
    return
  }

  const successRecords = learningState.success_patterns ?? []
  report.sourceRecords = successRecords.length
  console.error(`[bridge] 讀取到 ${successRecords.length} 筆成功模式`)

  if (successRecords.length === 0) {
    console.error("[bridge] 無成功模式可同步")
    report.status = "no_source"
    writeReport(report)
    process.exitCode = 0
    return
  }

  // ── 2. 開啟 nuwa.db ────────────────────────────────────────────────────────
  if (!fs.existsSync(NUWA_DB_PATH)) {
    console.error("[bridge] nuwa.db 不存在，請先執行 nuwa-mcp 初始化")
    report.status = "no_db"
    writeReport(report)
    process.exitCode = 0
    return
  }

  let db: {
    prepare: (sql: string) => {
      all: (...args: unknown[]) => unknown[]
      run: (...args: unknown[]) => void
      get: (...args: unknown[]) => unknown
    }
    pragma: (s: string) => void
    close: () => void
  }

  try {
    const { openDb } = await import("./lib/sqlite-compat.mjs") as {
      openDb: (p: string, opts?: unknown) => Promise<typeof db>
    }
    db = await openDb(NUWA_DB_PATH, { readonly: false })
    db.pragma("busy_timeout = 3000")
    db.pragma("journal_mode = WAL")
  } catch (err) {
    report.status = "error"
    report.errors.push(`開啟 nuwa.db 失敗: ${String(err).slice(0, 200)}`)
    writeReport(report)
    process.exitCode = 1
    return
  }

  // ── 3. 確保 patterns 表存在（參照 nuwa MCP schema）────────────────────────
  try {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE NOT NULL,
        target TEXT NOT NULL,
        context TEXT,
        mental_models TEXT,
        decay_score REAL NOT NULL DEFAULT 0.5,
        frozen INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run()
  } catch (err) {
    report.errors.push(`建立 patterns 表失敗: ${String(err).slice(0, 100)}`)
  }

  // ── 4. 按任務 ID 聚合成功次數，寫入 patterns ─────────────────────────────
  const taskSuccessCount: Record<string, { count: number; latest: LearningRecord }> = {}
  for (const rec of successRecords) {
    const taskId = extractTaskId(rec)
    if (!taskSuccessCount[taskId]) {
      taskSuccessCount[taskId] = { count: 0, latest: rec }
    }
    taskSuccessCount[taskId].count++
    if (rec.created_at > taskSuccessCount[taskId].latest.created_at) {
      taskSuccessCount[taskId].latest = rec
    }
  }

  for (const [taskId, { count, latest }] of Object.entries(taskSuccessCount)) {
    const slug = taskIdToSlug(taskId)
    // log1p 正規化：防止單一任務主導 nuwa.db 先驗注入
    // count=1→0.544, count=10→0.653, count=50→0.75, count=199→0.75（上限）
    const decayScore = Math.min(0.75, 0.5 + (Math.log1p(count) / Math.log1p(50)) * 0.25)
    const context = `Hermes 受控任務 ${taskId} 已成功執行 ${count} 次。最近：${latest.summary.slice(0, 150)}`
    const mentalModels = JSON.stringify(["controlled-task-success", `hermes:${taskId}`, "openclaw-loop"])

    try {
      const existing = db.prepare("SELECT slug, decay_score FROM patterns WHERE slug = ?").get(slug) as
        | { slug: string; decay_score: number }
        | undefined

      if (existing) {
        // 已存在：
        //   - 若現有值在合法範圍內（≤ 0.75），取較高值保留進步趨勢
        //   - 若現有值超出上限（舊公式膨脹），強制修正為新計算值
        const newScore = existing.decay_score > 0.75
          ? decayScore                                     // 強制修正舊膨脹值
          : Math.max(existing.decay_score, decayScore)    // 正常成長保留趨勢
        db.prepare(`
          UPDATE patterns SET
            context = ?,
            mental_models = ?,
            decay_score = ?,
            updated_at = datetime('now')
          WHERE slug = ?
        `).run(context, mentalModels, newScore, slug)
        report.updatedPatterns++
        console.error(`  ↑ 更新 [${slug}] decay_score: ${existing.decay_score.toFixed(3)} → ${newScore.toFixed(3)}`)
      } else {
        // 新插入（明確提供 created_at / updated_at，相容不同 nuwa.db schema 版本）
        db.prepare(`
          INSERT INTO patterns (slug, target, context, mental_models, decay_score, frozen, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
        `).run(slug, taskId, context, mentalModels, decayScore)
        report.newPatternsInserted++
        console.error(`  + 新增 [${slug}] decay_score=${decayScore.toFixed(3)} 成功次數=${count}`)
      }
    } catch (err) {
      const msg = `寫入 [${slug}] 失敗: ${String(err).slice(0, 100)}`
      report.errors.push(msg)
      report.skippedPatterns++
      console.error(`  ✗ ${msg}`)
    }
  }

  db.close()

  // ── 5. 輸出報告 ───────────────────────────────────────────────────────────
  console.error(`\n[bridge] 完成：新增 ${report.newPatternsInserted} / 更新 ${report.updatedPatterns} / 略過 ${report.skippedPatterns}`)
  if (report.errors.length > 0) {
    console.error(`[bridge] 錯誤 ${report.errors.length} 筆：`, report.errors.slice(0, 3).join(" | "))
    report.status = "error"
  }

  writeReport(report)
  process.stdout.write(JSON.stringify(report) + "\n")
}

function writeReport(report: BridgeReport) {
  try {
    fs.mkdirSync(path.dirname(BRIDGE_REPORT_PATH), { recursive: true })
    fs.writeFileSync(BRIDGE_REPORT_PATH, JSON.stringify(report, null, 2))
    console.error(`[bridge] 報告寫入：${BRIDGE_REPORT_PATH}`)
  } catch { /* 靜默 */ }
}

main().catch((err) => {
  console.error("[hermes-nuwa-bridge] 致命錯誤：", err)
  process.exitCode = 1
})
