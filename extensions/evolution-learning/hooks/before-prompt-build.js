#!/usr/bin/env node
/**
 * before-prompt-build.js — UserPromptSubmit Hook（記憶注入）ESM 版
 *
 * 在使用者提交 prompt 前自動注入：
 *   1. 最高 decay_score 的 top-3 nuwa patterns（認知框架）
 *   2. 最近 2 次對話摘要（上下文延續）
 *   3. 相關 causal_edges（高權重因果邊）
 *
 * Claude Code 設定（.claude/settings.json）：
 * {
 *   "hooks": {
 *     "UserPromptSubmit": [{
 *       "command": "node extensions/evolution-learning/hooks/before-prompt-build.js"
 *     }]
 *   }
 * }
 *
 * stdin：{ session_id, hook_event_name, prompt }
 * stdout：{ type: "context", content: "..." }  ← 注入額外上下文
 *
 * 任何錯誤都靜默退出，不中斷主流程
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

/** 從 prompt 文字抽取關鍵詞 */
function extractKeywords(text) {
  return text
    .replace(/[^\w\s一-鿿]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 10);
}

async function main() {
  const raw = await readStdin();

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  /** 新鮮度檢查：超過 maxAgeHours 的資料視為過期，返回 true */
  function isStale(filePath, maxAgeHours = 24) {
    try {
      const stat = fs.statSync(filePath);
      return Date.now() - stat.mtimeMs > maxAgeHours * 3_600_000;
    } catch {
      return true;
    }
  }

  const stateDir =
    process.env["NUWA_STATE_DIR"] ?? path.join(process.cwd(), ".claude", "evolution-state");

  try {
    const Database = require("better-sqlite3");
    const dbPath = path.join(stateDir, "nuwa.db");

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 2000");

    const userPrompt = data.prompt ?? "";
    const keywords = extractKeywords(userPrompt);

    // ── 1. Top-3 Patterns（依 decay_score DESC）
    const topPatterns = db
      .prepare(`
      SELECT slug, target, context, mental_models, decay_score
      FROM patterns
      WHERE frozen = 0
      ORDER BY decay_score DESC
      LIMIT 3
    `)
      .all();

    // ── 2. 相關 Patterns（FTS5 語義匹配）
    let relatedPatterns = [];
    if (keywords.length > 0 && topPatterns.length > 0) {
      try {
        const ftsQuery = keywords.map((k) => `"${k}"`).join(" OR ");
        const excludePlaceholders = topPatterns.map(() => "?").join(",");
        relatedPatterns = db
          .prepare(`
          SELECT p.slug, p.target, p.context, p.mental_models
          FROM patterns p
          JOIN patterns_fts f ON p.id = f.rowid
          WHERE patterns_fts MATCH ?
            AND p.slug NOT IN (${excludePlaceholders})
          ORDER BY rank
          LIMIT 2
        `)
          .all(ftsQuery, ...topPatterns.map((p) => p.slug));
      } catch {
        relatedPatterns = [];
      }
    }

    // ── 3. 最近 2 次對話摘要
    const recentConvs = db
      .prepare(`
      SELECT id, summary, dialogue_mode, started_at
      FROM conversations
      WHERE summary IS NOT NULL AND summary != ''
      ORDER BY started_at DESC
      LIMIT 2
    `)
      .all();

    // ── 4. 高權重因果邊（weight > 0.7，最多 5 條）
    const causalEdges = db
      .prepare(`
      SELECT from_slug, to_slug, relation, weight
      FROM causal_edges
      WHERE weight > 0.7
        AND (valid_to IS NULL OR valid_to > datetime('now'))
      ORDER BY weight DESC
      LIMIT 5
    `)
      .all();

    db.close();

    // ── 組裝注入內容
    const allPatterns = [...topPatterns, ...relatedPatterns];
    const hasContent = allPatterns.length > 0 || recentConvs.length > 0;

    if (!hasContent) {
      process.exit(0);
    }

    const lines = ["<!-- nuwa 記憶注入 (before_prompt_build) -->"];

    if (allPatterns.length > 0) {
      lines.push("\n## 激活的 nuwa 認知框架");
      for (const p of allPatterns) {
        lines.push(`\n### [${p.slug}] ${p.target}`);
        if (p.context) {
          lines.push(p.context.slice(0, 200));
        }
        if (p.mental_models) {
          try {
            const models = JSON.parse(p.mental_models);
            if (Array.isArray(models) && models.length > 0) {
              lines.push(`心智模型：${models.slice(0, 3).join(" / ")}`);
            }
          } catch {
            lines.push(`心智模型：${String(p.mental_models).slice(0, 100)}`);
          }
        }
        if (typeof p.decay_score === "number") {
          lines.push(`活躍度：${(p.decay_score * 100).toFixed(0)}%`);
        }
      }
    }

    if (recentConvs.length > 0) {
      lines.push("\n## 近期對話記憶");
      for (const c of recentConvs) {
        const date = c.started_at ? c.started_at.slice(0, 10) : "?";
        const mode = c.dialogue_mode && c.dialogue_mode !== "normal" ? ` [${c.dialogue_mode}]` : "";
        lines.push(`\n- [${date}${mode}] ${c.summary.slice(0, 150)}`);
      }
    }

    if (causalEdges.length > 0) {
      lines.push("\n## 相關因果圖（高權重）");
      for (const e of causalEdges) {
        lines.push(
          `- ${e.from_slug} →[${e.relation}]→ ${e.to_slug} (weight=${e.weight.toFixed(2)})`,
        );
      }
    }

    // ── 5. Hermes 最新閉環狀態（12h TTL：cron 每 30 分執行，12h 內資料視為新鮮）
    try {
      const hermesLatest = path.join(
        process.cwd(),
        "reports",
        "hermes-agent",
        "state",
        "openclaw-controlled-task-runner-latest.json", // 使用現行 controlled-task-runner 格式
      );
      if (fs.existsSync(hermesLatest) && !isStale(hermesLatest, 12)) {
        const hs = JSON.parse(fs.readFileSync(hermesLatest, "utf8"));
        lines.push("\n## Hermes 閉環最新狀態");
        lines.push(
          `- 任務: ${hs.task?.id ?? "?"} (${hs.task?.label ?? ""}) | 結果: ${hs.core_result ?? "?"}`,
        );
        lines.push(
          `- 執行時間: ${hs.task?.durationMs ?? "?"}ms | 退出碼: ${hs.task?.exitCode ?? "?"}`,
        );
        // 新格式：從 validation_result 讀取資金服務阻塞狀態
        const capStatus = hs.validation_result?.capital_service_status;
        if (capStatus && !capStatus.ready) {
          lines.push(
            `- 資金服務: ${capStatus.status ?? "blocked"} | 報價=${capStatus.quoteStatus ?? "?"}`,
          );
        }
        const wfFinal = hs.validation_result?.report_workflow?.finalStatus;
        if (wfFinal && wfFinal !== "pass") {
          lines.push(`- 工作流狀態: ${wfFinal}`);
        }
        lines.push(`- 產出時間: ${hs.generatedAt ?? "?"}`);
      }
    } catch {
      // Hermes state 不存在或解析失敗，靜默跳過
    }

    // ── 6. DMAD 三方辯論最新結論（8h TTL：smoke test 每 6h 執行，8h 內視為新鮮）
    try {
      const dmadLatest = path.join(process.cwd(), "reports", "dmad-run-test-latest.json");
      const dmadSmoke = path.join(process.cwd(), "reports", "dmad-smoke-test-latest.json");
      // 優先取 run-test，次取 smoke-test；均需通過 TTL 檢查
      const dmadPath =
        fs.existsSync(dmadLatest) && !isStale(dmadLatest, 8)
          ? dmadLatest
          : fs.existsSync(dmadSmoke) && !isStale(dmadSmoke, 8)
            ? dmadSmoke
            : null;
      if (dmadPath) {
        const dr = JSON.parse(fs.readFileSync(dmadPath, "utf8"));
        lines.push("\n## DMAD 三方辯論最新結論");
        lines.push(`- 執行時間: ${dr.completedAt ?? dr.timestamp ?? "?"}`);
        lines.push(
          `- 收斂分: ${typeof dr.convergenceScore === "number" ? dr.convergenceScore.toFixed(3) : "?"} | 輪數: ${dr.totalRounds ?? dr.rounds ?? "?"} | 停止原因: ${dr.stoppedBy ?? "?"}`,
        );
        lines.push(`- 使用 patterns: ${(dr.patternSlugsUsed ?? dr.patternsUsed ?? []).join(", ")}`);
        if (dr.finalAnswer) {
          lines.push(`- MoA 結論摘要: ${String(dr.finalAnswer).slice(0, 200)}`);
        }
      }
    } catch {
      // DMAD report 不存在或解析失敗，靜默跳過
    }

    // ── 6b. DMAD 元學習校準狀態（48h TTL：每日 03:00 更新）
    try {
      const calibPath = path.join(process.cwd(), "reports", "dmad-calibration.json");
      const metaPath = path.join(process.cwd(), "reports", "dmad-meta-learn-latest.json");
      if (fs.existsSync(calibPath) && !isStale(calibPath, 48)) {
        const calib = JSON.parse(fs.readFileSync(calibPath, "utf8"));
        lines.push("\n## DMAD 元學習校準狀態");
        lines.push(
          `- 建議收斂閾值: ${calib.suggestedConvergenceThreshold ?? "?"} | 建議最大輪數: ${calib.suggestedMaxRounds ?? "?"}`,
        );
        lines.push(`- 校準時間: ${calib.note ?? "?"}`);
      }
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        const recs = (meta.recommendations ?? []).slice(0, 2).join("；");
        if (recs) {
          lines.push(`- 系統建議: ${recs}`);
        }
        const drift = meta.calibrationDrift?.drift;
        if (drift && drift !== "stable") {
          lines.push(`- ⚠️ 收斂趨勢: ${drift}`);
        }
      }
    } catch {
      // 元學習報告不存在，靜默跳過
    }

    // ── 7. Hermes 受控任務學習記錄（48h TTL：hermes-nuwa-bridge 每日 03:30 更新）
    try {
      const hermesLearningPath = path.join(
        process.cwd(),
        "reports",
        "hermes-agent",
        "state",
        "learning-state.json",
      );
      if (fs.existsSync(hermesLearningPath) && !isStale(hermesLearningPath, 48)) {
        const ls = JSON.parse(fs.readFileSync(hermesLearningPath, "utf8"));
        const successes = (ls.success_patterns ?? []).slice(-3);
        const failures = (ls.failure_patterns ?? []).slice(-3);
        if (successes.length > 0 || failures.length > 0) {
          lines.push("\n## Hermes 受控任務學習記錄");
          if (successes.length > 0) {
            lines.push("**近期成功模式：**");
            for (const s of successes) {
              const date = s.created_at ? s.created_at.slice(0, 10) : "?";
              lines.push(
                `- [${date}][${(s.tags ?? []).join(",")}] ${String(s.summary ?? "").slice(0, 120)}`,
              );
            }
          }
          if (failures.length > 0) {
            lines.push("**近期失敗模式：**");
            for (const f of failures) {
              const date = f.created_at ? f.created_at.slice(0, 10) : "?";
              lines.push(
                `- [${date}][${(f.tags ?? []).join(",")}] ${String(f.summary ?? "").slice(0, 120)}`,
              );
            }
          }
          lines.push(
            `- 成功/失敗 總計: ${ls.success_patterns?.length ?? 0}/${ls.failure_patterns?.length ?? 0} | 更新: ${ls.updated_at?.slice(0, 10) ?? "?"}`,
          );
        }
      }
    } catch {
      // Hermes 學習狀態不存在或解析失敗，靜默跳過
    }

    lines.push("\n<!-- /nuwa 記憶注入 -->");

    process.stdout.write(
      JSON.stringify({
        type: "context",
        content: lines.join("\n"),
      }) + "\n",
    );
  } catch (err) {
    // DB 尚未初始化時，輸出輕量提示（不阻斷主流程）
    if (err && typeof err === "object" && "code" in err && err.code === "SQLITE_CANTOPEN") {
      process.stdout.write(
        JSON.stringify({
          type: "context",
          content: "<!-- nuwa: DB 尚未初始化，請執行 `nuwa-mcp` 啟動 MCP Server 以開始記憶學習 -->",
        }) + "\n",
      );
    }
    // 其他錯誤靜默退出
    process.exit(0);
  }

  process.exit(0);
}

void main();
