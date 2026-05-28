/**
 * dmad-collab-codex.mts — Claude × Codex 協作改進腳本
 *
 * 用法：pnpm dmad:collab
 *
 * 功能：
 *   1. 讀取 docs/dmad-collab-brief.md（Claude 對 Codex 的任務簡報）
 *   2. 呼叫 Codex CLI 對 routeTask / rcr / trend-report 進行技術審查與改進
 *   3. Codex 直接修改目標檔案（workspace-write 模式）
 *   4. 執行 TypeScript 型別驗證 + smoke-test 確認改進有效
 *   5. 輸出協作結果報告
 */

import path from "node:path"
import fs from "node:fs"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(scriptDir, "..")
const BRIEF_PATH = path.join(REPO_ROOT, "docs", "dmad-collab-brief.md")
const REPORT_PATH = path.join(REPO_ROOT, "reports", "dmad-collab-latest.json")

// ── 工具函數 ──────────────────────────────────────────────────────────────────

function stringifyCodexValue(value: unknown): string {
  if (value === null || value === undefined) {
    return ""
  }
  if (typeof value === "string") {
    return value
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value)
  }
  try {
    const json = JSON.stringify(value)
    return typeof json === "string" ? json : ""
  } catch {
    return ""
  }
}

function runCommand(cmd: string, args: string[], timeoutMs = 120_000): Promise<{
  ok: boolean; stdout: string; stderr: string; durationMs: number
}> {
  return new Promise(resolve => {
    const start = Date.now()
    const proc = spawn(cmd, args, {
      cwd: REPO_ROOT,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })
    const out: string[] = []
    const err: string[] = []
    proc.stdout?.on("data", (d: Buffer) => out.push(d.toString()))
    proc.stderr?.on("data", (d: Buffer) => err.push(d.toString()))
    const timer = setTimeout(() => proc.kill("SIGTERM"), timeoutMs)
    proc.on("close", code => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout: out.join(""), stderr: err.join(""), durationMs: Date.now() - start })
    })
    proc.on("error", e => {
      clearTimeout(timer)
      resolve({ ok: false, stdout: "", stderr: String(e), durationMs: Date.now() - start })
    })
  })
}

async function callCodexWithBrief(brief: string, timeoutMs = 360_000): Promise<{
  ok: boolean; output: string; durationMs: number; improvements?: Record<string, string>
}> {
  console.error("  → 呼叫 Codex CLI（workspace-write，timeout: 360s）...")
  return new Promise(resolve => {
    const start = Date.now()
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn("codex", [
        "exec",
        "--json",
        "-m", "gpt-4.1",
        "-s", "workspace-write",
        "-",
      ], {
        cwd: REPO_ROOT,
        shell: process.platform === "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (err) {
      resolve({ ok: false, output: `[Codex 啟動失敗：${String(err)}]`, durationMs: 0 })
      return
    }

    proc.stdin?.write(brief)
    proc.stdin?.end()

    const chunks: string[] = []
    proc.stdout?.on("data", (d: Buffer) => chunks.push(d.toString()))

    const timer = setTimeout(() => proc.kill("SIGTERM"), timeoutMs)
    proc.on("close", () => {
      clearTimeout(timer)
      const raw = chunks.join("")
      // 解析 Codex JSONL 輸出
      const lines = raw.split("\n").filter(Boolean)
      let output = ""
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const ev = JSON.parse(lines[i]) as Record<string, unknown>
          if (ev["type"] === "item.completed") {
            const item = ev["item"] as Record<string, unknown>
            output = stringifyCodexValue(item?.["text"] ?? item?.["output"])
            break
          }
          if (ev["type"] === "turn.completed") {
            const payload = ev["payload"] as Record<string, unknown>
            output = stringifyCodexValue(payload?.["content"])
            break
          }
          // reasoning_summary 或 message 事件
          if (ev["type"] === "message" && (ev["role"] === "assistant" || !ev["role"])) {
            const content = ev["content"]
            output = typeof content === "string" ? content : JSON.stringify(content)
          }
        } catch { /* skip non-JSON lines */ }
      }
      if (!output) {
        output = raw.slice(0, 1000)
      }

      // 嘗試解析 Codex 回傳的 JSON 結果
      let improvements: Record<string, string> | undefined
      try {
        const jsonMatch = output.match(/\{[\s\S]*"ok"[\s\S]*\}/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
          if (parsed["improvements"]) {
            improvements = parsed["improvements"] as Record<string, string>
          }
        }
      } catch { /* ignore */ }

      resolve({ ok: true, output: output.slice(0, 2000), durationMs: Date.now() - start, improvements })
    })
    proc.on("error", err => {
      clearTimeout(timer)
      const msg = (err as NodeJS.ErrnoException).code === "ENOENT"
        ? "[Codex CLI 未安裝，請執行 npm install -g @openai/codex]"
        : `[Codex 呼叫失敗：${String(err).slice(0, 100)}]`
      resolve({ ok: false, output: msg, durationMs: Date.now() - start })
    })
  })
}

// ── 主程式 ──────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now()

  console.error("=================================================")
  console.error("[dmad-collab] Claude × Codex 協作改進工作流程")
  console.error("=================================================\n")

  // 1. 讀取任務簡報
  let brief: string
  try {
    brief = fs.readFileSync(BRIEF_PATH, "utf-8")
  } catch {
    console.error(`[dmad-collab] ❌ 無法讀取任務簡報：${BRIEF_PATH}`)
    process.exitCode = 1
    return
  }
  console.error(`[Step 1] 讀取任務簡報：${brief.length} 字元`)

  // 2. 呼叫 Codex CLI
  console.error("\n[Step 2] 呼叫 Codex CLI 進行技術審查與改進...")
  const codexResult = await callCodexWithBrief(brief, 360_000)
  console.error(`  Codex 完成（${(codexResult.durationMs / 1000).toFixed(1)}s）`)
  console.error(`  ok：${codexResult.ok}`)
  if (codexResult.improvements) {
    console.error("  改進摘要：")
    for (const [k, v] of Object.entries(codexResult.improvements)) {
      console.error(`    ${k}：${v.slice(0, 100)}`)
    }
  } else {
    console.error(`  輸出（前 300 字）：${codexResult.output.slice(0, 300)}`)
  }

  // 3. TypeScript 驗證
  console.error("\n[Step 3] TypeScript 型別驗證...")
  const tsResult = await runCommand("pnpm", ["tsx", "--check",
    "extensions/evolution-learning/src/dmad-debate.ts"], 60_000)
  console.error(`  TypeCheck：${tsResult.ok ? "✅ 通過" : "❌ 失敗"}`)
  if (!tsResult.ok) {
    console.error(`  錯誤：${(tsResult.stdout + tsResult.stderr).slice(0, 300)}`)
  }

  // 4. Smoke Test 驗證
  console.error("\n[Step 4] Smoke Test 驗證（最多 300s）...")
  const smokeResult = await runCommand("pnpm", ["dmad:smoke-test"], 300_000)
  console.error(`  SmokeTest：${smokeResult.ok ? "✅ 通過" : "❌ 失敗"}`)
  let smokeMetrics: Record<string, unknown> = {}
  try {
    const raw = fs.readFileSync(path.join(REPO_ROOT, "reports", "dmad-smoke-test-latest.json"), "utf-8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    smokeMetrics = {
      convergenceScore: parsed["convergenceScore"],
      totalRounds: parsed["totalRounds"],
      stoppedBy: parsed["stoppedBy"],
    }
  } catch { /* ignore */ }
  if (smokeMetrics["convergenceScore"]) {
    const totalRounds = stringifyCodexValue(smokeMetrics["totalRounds"])
    const convergenceScore = stringifyCodexValue(smokeMetrics["convergenceScore"]).slice(0, 6)
    const stoppedBy = stringifyCodexValue(smokeMetrics["stoppedBy"])
    console.error(`  metrics：rounds=${totalRounds}  conv=${convergenceScore}  stoppedBy=${stoppedBy}`)
  }

  // 5. 趨勢分析更新
  console.error("\n[Step 5] 更新趨勢分析報告...")
  const trendResult = await runCommand("pnpm", ["dmad:trend"], 30_000)
  console.error(`  TrendCheck：${trendResult.ok ? "✅ 通過" : "❌ 失敗"}`)

  // 最終報告
  const totalMs = Date.now() - startMs
  const report = {
    generatedAt: new Date().toISOString(),
    totalDurationMs: totalMs,
    codex: {
      ok: codexResult.ok,
      durationMs: codexResult.durationMs,
      improvements: codexResult.improvements,
      outputExcerpt: codexResult.output.slice(0, 500),
    },
    typeCheck: { ok: tsResult.ok },
    smokeTest: { ok: smokeResult.ok, metrics: smokeMetrics },
    trendUpdate: { ok: trendResult.ok },
    overallOk: codexResult.ok && tsResult.ok && smokeResult.ok,
  }

  console.error("\n=================================================")
  console.error("[dmad-collab] 協作完成！")
  console.error(`  總耗時：${(totalMs / 1000).toFixed(1)}s`)
  console.error(`  整體狀態：${report.overallOk ? "✅ 成功" : "⚠️ 部分失敗"}`)
  console.error("=================================================")

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true })
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2))
  console.error(`[dmad-collab] 報告寫入：${REPORT_PATH}`)

  process.stdout.write(JSON.stringify(report) + "\n")
  if (!report.overallOk) {
    process.exitCode = 1
  }
}

main().catch(err => {
  console.error("[dmad-collab] 致命錯誤：", err)
  process.exitCode = 1
})
