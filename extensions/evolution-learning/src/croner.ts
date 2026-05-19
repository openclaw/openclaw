/**
 * croner.ts — nuwa 背景排程
 *
 * 由 mcp/server.ts 啟動時呼叫 startCroner(db, stateDir)。
 * 使用 Node.js setInterval 實作，不依賴外部 cron 套件。
 *
 * 排程：
 *   每晚 03:00  — REM 衰減（decay_score × 0.98，閒置 > 7 天的 pattern）
 *   每 6 小時   — causal_edges GC（清除 weight < 0.1 的舊邊）
 *   每週日      — EvoAgentX 角色演化週期
 *   每月 1 日   — pattern_versions 快照壓縮
 *   每 15 天    — 訂閱查驗
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { syncHermesToCausal } from "../../../tools/openclaw_runtime/task_bus/writeback.js";
import { runEvolutionCycle } from "./role-evolution.js";

// ── 公開型別 ────────────────────────────────────────────────────────────────

export interface CronerResult {
  task: string;
  ran: boolean;
  affected?: number;
  error?: string;
}

// ── 輔助函數 ─────────────────────────────────────────────────────────────────

/**
 * 計算從現在到下一次 hour:00:00 的毫秒數。
 * 若今天的 hour 已過，目標改為明天同一時刻。
 */
function msUntilNextHour(hour: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

/**
 * 等到下一次 hour:00:00，然後每 24 小時重複執行。
 * hour 必須在 0–23 之間，否則拋出 Error。
 */
function scheduleDaily(hour: number, fn: () => void): void {
  if (hour < 0 || hour > 23) {
    throw new Error(`scheduleDaily: hour 必須介於 0–23，收到 ${hour}`);
  }
  const delay = msUntilNextHour(hour);
  setTimeout(() => {
    fn();
    setInterval(fn, 24 * 60 * 60 * 1000);
  }, delay);
}

/** 是否為每月第 day 日（day=1 代表 1 號）*/
function isNthDayOfMonth(day: number): boolean {
  return new Date().getDate() === day;
}

/** 是否為週日（0 = Sunday）*/
function isSunday(): boolean {
  return new Date().getDay() === 0;
}

/** 距離 lastRan 是否已超過 days 天（lastRan=null 視為已超過）*/
function isDaysAgo(days: number, lastRan: Date | null): boolean {
  if (lastRan === null) {
    return true;
  }
  const ms = days * 24 * 60 * 60 * 1000;
  return Date.now() - lastRan.getTime() >= ms;
}

function resolveHermesLearningStatePath(stateDir: string): string | null {
  const candidates = [
    path.resolve(
      stateDir,
      "..",
      "..",
      "..",
      "..",
      "reports",
      "hermes-agent",
      "state",
      "learning-state.json",
    ),
    path.resolve(stateDir, "..", "..", "reports", "hermes-agent", "state", "learning-state.json"),
    path.join(process.cwd(), "reports", "hermes-agent", "state", "learning-state.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// ── 個別排程任務 ──────────────────────────────────────────────────────────────

function runRemDecay(db: Database.Database, stateDir: string): CronerResult {
  try {
    const result = db
      .prepare(`
      UPDATE patterns
      SET decay_score = MAX(0.01, decay_score * 0.98),
          updated_at = datetime('now')
      WHERE frozen = 0
        AND decay_score > 0.01
        AND (last_activated IS NULL OR last_activated < datetime('now', '-7 days'))
    `)
      .run();

    const affected = result.changes;
    db.prepare(`
      INSERT INTO learning_events (id, pattern_slug, event_type, payload, source, recorded_at)
      VALUES (?, NULL, 'rem_decay', ?, 'croner', datetime('now'))
    `).run(randomUUID(), JSON.stringify({ affected }));

    // 方向 B：Hermes learning-state → nuwa causal_edges
    const learningStatePath = resolveHermesLearningStatePath(stateDir);
    if (learningStatePath) {
      syncHermesToCausal(db, learningStatePath);
      console.log(`[nuwa croner] Hermes → causal_edges 同步完成`);
    }

    console.log(`[nuwa croner] REM 衰減完成：${affected} 個 pattern`);
    return { task: "rem_decay", ran: true, affected };
  } catch (err) {
    const error = String(err);
    console.error(`[nuwa croner] REM 衰減失敗：`, err);
    return { task: "rem_decay", ran: false, error };
  }
}

function runCausalEdgesGc(db: Database.Database): CronerResult {
  try {
    const r1 = db
      .prepare(`
      DELETE FROM causal_edges
      WHERE (weight < 0.1 AND valid_to IS NOT NULL)
         OR (valid_to < datetime('now', '-90 days'))
    `)
      .run();

    const r2 = db
      .prepare(`
      DELETE FROM causal_edges
      WHERE relation IN ('got_strategy', 'constitution_win', 'persona_evolution')
        AND weight < 0.05
    `)
      .run();

    const affected = r1.changes + r2.changes;
    console.log(`[nuwa croner] causal_edges GC 完成：清除 ${affected} 筆舊邊`);
    return { task: "causal_edges_gc", ran: true, affected };
  } catch (err) {
    const error = String(err);
    console.error(`[nuwa croner] causal_edges GC 失敗：`, err);
    return { task: "causal_edges_gc", ran: false, error };
  }
}

async function runEvoAgentX(db: Database.Database, stateDir: string): Promise<CronerResult> {
  try {
    const learningStatePath =
      resolveHermesLearningStatePath(stateDir) ??
      path.join(process.cwd(), "reports", "hermes-agent", "state", "learning-state.json");
    const result = await runEvolutionCycle(db, learningStatePath);
    console.log(
      `[nuwa croner] EvoAgentX 演化完成：evaluated=${result.evaluated} evolved=${result.evolved} pruned=${result.pruned} skipped=${result.skipped}`,
    );
    return { task: "evo_agentx", ran: true };
  } catch (err) {
    const error = String(err);
    console.error(`[nuwa croner] EvoAgentX 演化失敗：`, err);
    return { task: "evo_agentx", ran: false, error };
  }
}

function runPatternVersionSnapshot(db: Database.Database): CronerResult {
  try {
    const patterns = db
      .prepare(`
      SELECT slug, confidence, decay_score, sample_count, scope
      FROM patterns
      WHERE frozen = 0
    `)
      .all() as Array<{
      slug: string;
      confidence: number;
      decay_score: number;
      sample_count: number;
      scope: string;
    }>;

    const versionTag = new Date().toISOString().slice(0, 7); // e.g. "2026-05"
    const now = new Date().toISOString();

    const insert = db.prepare(`
      INSERT INTO pattern_versions (id, pattern_slug, snapshot, version_tag, snapshotted_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const run = db.transaction(() => {
      for (const p of patterns) {
        insert.run(
          randomUUID(),
          p.slug,
          JSON.stringify({
            confidence: p.confidence,
            decay_score: p.decay_score,
            sample_count: p.sample_count,
            scope: p.scope,
          }),
          versionTag,
          now,
        );
      }
    });
    run();

    console.log(
      `[nuwa croner] pattern_versions 快照完成：${patterns.length} 個 pattern（${versionTag}）`,
    );
    return { task: "pattern_snapshot", ran: true, affected: patterns.length };
  } catch (err) {
    const error = String(err);
    console.error(`[nuwa croner] pattern_versions 快照失敗：`, err);
    return { task: "pattern_snapshot", ran: false, error };
  }
}

function runSubscriptionCheck(db: Database.Database): CronerResult {
  try {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO learning_events (id, pattern_slug, event_type, payload, source, recorded_at)
      VALUES (?, NULL, 'subscription_check', ?, 'croner', ?)
    `).run(randomUUID(), JSON.stringify({ checkAt: now }), now);

    console.log(`[nuwa croner] 訂閱查驗事件已記錄`);
    return { task: "subscription_check", ran: true };
  } catch (err) {
    const error = String(err);
    console.error(`[nuwa croner] 訂閱查驗失敗：`, err);
    return { task: "subscription_check", ran: false, error };
  }
}

// ── 主要導出函數 ──────────────────────────────────────────────────────────────

/**
 * 啟動所有 Croner 背景排程。
 * 由 mcp/server.ts 啟動時呼叫一次，之後自動維持。
 *
 * @param db     local nuwa.db 實例（已套用 WAL pragma）
 * @param stateDir 插件工作目錄（目前供 EvoAgentX 路徑解析使用）
 */
export function startCroner(db: Database.Database, stateDir: string): void {
  // 每晚 03:00 — REM 衰減
  scheduleDaily(3, () => {
    runRemDecay(db, stateDir);
  });

  // 每 6 小時 — causal_edges GC
  setInterval(
    () => {
      runCausalEdgesGc(db);
    },
    6 * 60 * 60 * 1000,
  );

  // 每晚 03:30 — 若為週日則執行 EvoAgentX 演化
  scheduleDaily(3, () => {
    if (!isSunday()) {
      return;
    }
    // 加 30 分鐘偏移，避免與 REM 衰減在同一刻競爭 WAL 鎖
    setTimeout(
      () => {
        runEvoAgentX(db, stateDir).catch((err) => {
          console.error(`[nuwa croner] EvoAgentX 未捕獲錯誤：`, err);
        });
      },
      30 * 60 * 1000,
    );
  });

  // 每天 04:00 — 若為每月 1 日則執行快照
  scheduleDaily(4, () => {
    if (!isNthDayOfMonth(1)) {
      return;
    }
    runPatternVersionSnapshot(db);
  });

  // 每 15 天 — 訂閱查驗（每天檢查一次，若距上次已滿 15 天則觸發）
  let lastSubCheck: Date | null = null;
  setInterval(
    () => {
      if (isDaysAgo(15, lastSubCheck)) {
        runSubscriptionCheck(db);
        lastSubCheck = new Date();
      }
    },
    24 * 60 * 60 * 1000,
  );

  // 首次啟動 6 小時後執行一次 GC（避免立刻就跑）
  setTimeout(
    () => {
      runCausalEdgesGc(db);
    },
    6 * 60 * 60 * 1000,
  );
}
