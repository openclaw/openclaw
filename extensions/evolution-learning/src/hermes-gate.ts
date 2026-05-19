/**
 * hermes-gate.ts — Hermes interrupt() 審批閘道（⑯）
 *
 * 5 級風險分類：
 *   read_only        → 直接放行
 *   local_write      → 直接放行（本地讀寫無需審批）
 *   external_write   → ⚠️ 需人工確認（外部 HTTP/webhook/email）
 *   trading_payment  → 🚨 需人工確認（金融交易）
 *   credential       → 🔐 需人工確認（憑證/密鑰操作）
 *
 * 使用方式（MCP tool 或 Task Bus 呼叫前）：
 *   const gate = createHermesGate(db, stateDir)
 *   const decision = await gate.checkRisk(pkg)
 *   if (decision.blocked) return // 使用者拒絕或超時
 *
 * interrupt() 實作：
 *   在終端輸出警示 + 等待使用者輸入（stdin readline）。
 *   若在非互動環境（CI/MCP）則自動拒絕（安全第一）。
 *
 * 拒絕後自動寫入 Hermes learning-state.json failure 記錄。
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type Database from "better-sqlite3";

// ── 公開型別 ──────────────────────────────────────────────────────────────────

export type RiskClass =
  | "read_only"
  | "local_write"
  | "external_write"
  | "trading_payment"
  | "credential";

export interface RiskTask {
  id?: string;
  task: string;
  riskClass: RiskClass;
  preview?: string; // 操作摘要（供使用者確認）
  source?: string; // 任務來源（claude_cli / codex / mcp_tool）
}

export interface GateDecision {
  allowed: boolean;
  blocked: boolean;
  riskClass: RiskClass;
  reason: string; // 允許/拒絕原因
  traceId: string; // 用於 learning-state.json 記錄
}

// ── 風險分類工具 ──────────────────────────────────────────────────────────────

const APPROVAL_RISKS: ReadonlySet<RiskClass> = new Set([
  "external_write",
  "trading_payment",
  "credential",
]);

export function classifyRisk(task: string): RiskClass {
  const lower = task.toLowerCase();
  if (/credential|secret|password|api.?key|token|private.?key/i.test(lower)) {
    return "credential";
  }
  if (/trade|payment|buy|sell|order|交易|付款|invoice/i.test(lower)) {
    return "trading_payment";
  }
  if (/http|curl|fetch|webhook|email|send|push|外發|notify|alert/i.test(lower)) {
    return "external_write";
  }
  if (/write|save|delete|rm|modify|edit|create.*file|寫入|刪除|修改/i.test(lower)) {
    return "local_write";
  }
  return "read_only";
}

export function isApprovalRequired(risk: RiskClass): boolean {
  return APPROVAL_RISKS.has(risk);
}

// ── 風險圖示 ──────────────────────────────────────────────────────────────────

const RISK_EMOJI: Record<RiskClass, string> = {
  read_only: "✅",
  local_write: "📝",
  external_write: "⚠️",
  trading_payment: "🚨",
  credential: "🔐",
};

// ── Hermes learning-state 記錄 ────────────────────────────────────────────────

interface HermesRecord {
  id: string;
  timestamp: string;
  status: "success" | "failure";
  summary: string;
  tags: string[];
}

interface LearningState {
  records?: HermesRecord[];
}

function appendLearningRecord(
  stateDir: string,
  record: Omit<HermesRecord, "id" | "timestamp">,
): void {
  const filePath = path.join(stateDir, "learning-state.json");
  let state: LearningState = {};
  try {
    state = JSON.parse(fs.readFileSync(filePath, "utf8")) as LearningState;
  } catch {
    /* 不存在時從空開始 */
  }

  const records = state.records ?? [];
  records.push({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    ...record,
  });

  // 最多保留 200 筆
  if (records.length > 200) {
    records.splice(0, records.length - 200);
  }
  state.records = records;

  try {
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* 寫入失敗靜默 */
  }
}

// ── readline interrupt（互動模式）────────────────────────────────────────────

/**
 * 在終端顯示風險警示並等待使用者輸入 y/n。
 * 非互動環境（process.stdin 無 isTTY）→ 自動拒絕。
 * 超時 30 秒 → 自動拒絕。
 */
async function interruptForApproval(task: RiskTask): Promise<boolean> {
  // 非互動環境（CI / MCP stdio）→ 安全拒絕
  if (!process.stdin.isTTY) {
    console.warn(
      `[Hermes Gate] ${RISK_EMOJI[task.riskClass]} ` +
        `非互動環境，高風險任務自動拒絕（${task.riskClass}）`,
    );
    return false;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // 輸出到 stderr，避免污染 MCP stdout
  });

  const msg = [
    "",
    `╔══════════════════════════════════════════════════════╗`,
    `║  ${RISK_EMOJI[task.riskClass]} Hermes 審批閘道 — 高風險操作                    ║`,
    `╠══════════════════════════════════════════════════════╣`,
    `║  風險等級：${task.riskClass.padEnd(42)}║`,
    `║  任務摘要：${task.task.slice(0, 42).padEnd(42)}║`,
    task.preview ? `║  操作預覽：${task.preview.slice(0, 42).padEnd(42)}║` : null,
    `║  來源    ：${(task.source ?? "unknown").padEnd(42)}║`,
    `╠══════════════════════════════════════════════════════╣`,
    `║  繼續執行請輸入 y，拒絕請輸入 n（30 秒後自動拒絕） ║`,
    `╚══════════════════════════════════════════════════════╝`,
    "",
  ]
    .filter(Boolean)
    .join("\n");

  process.stderr.write(msg);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      rl.close();
      process.stderr.write("\n[Hermes Gate] 超時（30s），自動拒絕。\n");
      resolve(false);
    }, 30_000);

    rl.question("[Hermes Gate] 確認執行？(y/n): ", (answer) => {
      clearTimeout(timer);
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

// ── HermesGate 主類 ───────────────────────────────────────────────────────────

export class HermesGate {
  constructor(
    private readonly db: Database.Database,
    private readonly stateDir: string,
  ) {}

  /**
   * 檢查任務風險並決定是否放行。
   * 高風險任務會觸發 interrupt()（互動確認），拒絕後寫入 failure 記錄。
   */
  async checkRisk(task: RiskTask): Promise<GateDecision> {
    const traceId = task.id ?? randomUUID();
    const risk = task.riskClass ?? classifyRisk(task.task);

    // 放行：低風險
    if (!isApprovalRequired(risk)) {
      return {
        allowed: true,
        blocked: false,
        riskClass: risk,
        reason: `低風險（${risk}），直接放行`,
        traceId,
      };
    }

    // 需要審批：觸發 interrupt()
    const approved = await interruptForApproval({ ...task, riskClass: risk });

    if (approved) {
      // 記錄批准
      this.writeLearningEvent("success", task, traceId);
      return {
        allowed: true,
        blocked: false,
        riskClass: risk,
        reason: `使用者批准（${risk}）`,
        traceId,
      };
    }

    // 拒絕：寫入 failure 記錄
    this.writeLearningEvent("failure", task, traceId);
    return {
      allowed: false,
      blocked: true,
      riskClass: risk,
      reason: `使用者拒絕或超時（${risk}）`,
      traceId,
    };
  }

  private writeLearningEvent(status: "success" | "failure", task: RiskTask, traceId: string): void {
    // 1. SQLite learning_events
    try {
      this.db
        .prepare(`
        INSERT INTO learning_events (id, pattern_slug, event_type, payload, source, recorded_at)
        VALUES (?, NULL, ?, ?, 'hermes_gate', datetime('now'))
      `)
        .run(
          randomUUID(),
          status === "success" ? "gate_approved" : "gate_rejected",
          JSON.stringify({
            traceId,
            riskClass: task.riskClass,
            task: task.task.slice(0, 200),
            source: task.source ?? "unknown",
          }),
        );
    } catch {
      /* 靜默 */
    }

    // 2. Hermes learning-state.json
    appendLearningRecord(this.stateDir, {
      status,
      summary:
        status === "success"
          ? `[GATE APPROVED] ${task.riskClass}：${task.task.slice(0, 100)}`
          : `[GATE REJECTED] ${task.riskClass}：${task.task.slice(0, 100)}`,
      tags: [task.riskClass, status === "success" ? "gate_approved" : "gate_rejected"],
    });
  }
}

/**
 * 工廠函數（供 MCP server 和 Task Bus 使用）
 */
export function createHermesGate(db: Database.Database, stateDir: string): HermesGate {
  return new HermesGate(db, stateDir);
}
