/**
 * cost-guard.ts — 訂閱感知費用守衛
 *
 * 所有決策都基於 SubscriptionRegistry：
 *   1. 操作被現有訂閱覆蓋 → 直接放行（你已付過訂閱費了）
 *   2. 操作有 API Key 可用但 per-token 計費 → 估算費用 → 必須確認
 *   3. 操作無任何覆蓋（沒訂閱也沒 key）→ 硬拒絕，說明需要哪個訂閱
 *   4. 超過月預算 → 根據 overBudgetBehavior 決定封鎖或警告
 *
 * 環境變數（快速設定）：
 *   NUWA_CLAUDE_TIER    = "max-20" | "max-5" | "pro" | "free"
 *   NUWA_OPENAI_TIER    = "pro" | "plus" | "free"
 *   ANTHROPIC_API_KEY   = sk-ant-...
 *   OPENAI_API_KEY      = sk-...
 *   TAVILY_API_KEY      = tvly-...
 *   NUWA_AUTO_APPROVE   = "true"（僅測試用，生產環境不建議）
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  SubscriptionRegistry,
  createSubscriptionRegistry,
  fmtDate,
  type NuwaOperation,
  type SubscriptionPlan,
} from "./subscription-registry.js";

// ─── 型別 ───────────────────────────────────────────────────────────

export type CostCheckResult = {
  allowed: boolean;
  isFree: boolean; // 被訂閱覆蓋，零額外費用
  estimatedUsd: number; // 0 = 免費，>0 = 需要付費，-1 = 無法執行
  coveringPlan?: SubscriptionPlan;
  reason: string;
  requiresConfirmation: boolean;
};

export type CostLogEntry = {
  timestamp: string;
  operation: NuwaOperation;
  allowed: boolean;
  isFree: boolean;
  estimatedUsd: number;
  coveringPlanId?: string;
  detail: string;
};

// ─── CostGuard 主類別 ────────────────────────────────────────────────

export class CostGuard {
  private readonly registry: SubscriptionRegistry;
  private readonly logPath: string;
  private readonly autoApprove: boolean;

  constructor(stateDir: string) {
    this.registry = createSubscriptionRegistry(stateDir);
    this.logPath = path.join(stateDir, "cost-log.jsonl");
    this.autoApprove = process.env.NUWA_AUTO_APPROVE === "true";
  }

  // ── 核心：檢查一個操作是否可以進行 ──────────────────────────────

  async check(
    operation: NuwaOperation,
    params: { inputTokens?: number; outputTokens?: number; callCount?: number } = {},
  ): Promise<CostCheckResult> {
    // Step 1：查詢訂閱覆蓋
    const coverage = await this.registry.isCovered(operation);

    if (coverage.covered) {
      return {
        allowed: true,
        isFree: true,
        estimatedUsd: 0,
        coveringPlan: coverage.coveringPlan,
        reason: `✅ ${coverage.reason}`,
        requiresConfirmation: false,
      };
    }

    // Step 2：估算 per-token 費用（可能有 API key 但沒有對應訂閱）
    const estimate = await this.registry.estimateCost(operation, params);

    if (estimate.estimatedUsd === -1) {
      // 完全無法執行
      return {
        allowed: false,
        isFree: false,
        estimatedUsd: -1,
        reason:
          `🚫 無法執行「${operation}」：\n` +
          `   ${estimate.detail}\n` +
          `   請執行 nuwa sub add <訂閱方案> 來登記對應訂閱。\n` +
          `   執行 nuwa sub plans 查看所有可用方案。`,
        requiresConfirmation: false,
      };
    }

    // Step 3：有 API key 可以付費執行，但需要確認
    if (this.autoApprove) {
      return {
        allowed: true,
        isFree: false,
        estimatedUsd: estimate.estimatedUsd,
        coveringPlan: estimate.usingPlan,
        reason: `⚠️  自動核准（NUWA_AUTO_APPROVE=true）— ${estimate.detail}`,
        requiresConfirmation: false,
      };
    }

    // 需要用戶確認
    return {
      allowed: false, // 預設不允許，需要用戶明確確認
      isFree: false,
      estimatedUsd: estimate.estimatedUsd,
      coveringPlan: estimate.usingPlan,
      reason:
        `💰 此操作將產生費用（非訂閱覆蓋）：\n` +
        `   ${estimate.detail}\n` +
        `   操作：${operation}\n` +
        `   如需執行：\n` +
        `     • 登記對應訂閱：nuwa sub add <方案> （讓訂閱費覆蓋此操作）\n` +
        `     • 或設定 NUWA_AUTO_APPROVE=true 自動核准（謹慎使用）`,
      requiresConfirmation: true,
    };
  }

  // ── 便利方法：check + 記錄 + 輸出訊息 ──────────────────────────

  /**
   * 主要使用介面：
   *   const ok = await guard.gate("tavily_search", { callCount: 1 });
   *   if (!ok) return; // 被攔截，訊息已印出
   */
  async gate(
    operation: NuwaOperation,
    params: { inputTokens?: number; outputTokens?: number; callCount?: number } = {},
  ): Promise<boolean> {
    const result = await this.check(operation, params);

    // 記錄
    await this.log({
      timestamp: new Date().toISOString(),
      operation,
      allowed: result.allowed,
      isFree: result.isFree,
      estimatedUsd: result.estimatedUsd,
      coveringPlanId: result.coveringPlan?.id,
      detail: result.reason,
    });

    if (!result.allowed) {
      process.stderr.write(`\n${result.reason}\n\n`);
      return false;
    }

    // 有費用但已核准（auto-approve）→ 提示
    if (!result.isFree && result.estimatedUsd > 0) {
      process.stderr.write(`💰 費用提示：${result.reason}\n`);
    }

    return true;
  }

  // ── 費用日誌 ────────────────────────────────────────────────────

  private async log(entry: CostLogEntry): Promise<void> {
    try {
      await fs.appendFile(this.logPath, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      /* 不中斷主流程 */
    }
  }

  async readLog(): Promise<CostLogEntry[]> {
    try {
      const raw = await fs.readFile(this.logPath, "utf8");
      return raw
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as CostLogEntry);
    } catch {
      return [];
    }
  }

  // ── 計費週期費用匯總（按訂閱登記日算，非日曆月）──────────────
  //
  // 邏輯：找最早登記的付費訂閱，以其登記日為計費週期基準。
  //   沒有付費訂閱 → 退回日曆月。
  //

  async monthlySummary(): Promise<{
    periodLabel: string; // 顯示用標籤（例："2026-05-15 → 2026-06-15"）
    periodStart: string; // ISO
    periodEnd: string; // ISO
    daysRemaining: number;
    totalEstimatedUsd: number;
    freeOperations: number;
    paidOperations: number;
    blockedOperations: number;
    byOperation: Record<string, { count: number; estimatedUsd: number }>;
  }> {
    // 找計費週期
    const file = await this.registry.load();
    const activePlans = await this.registry.getActivePlans();
    const paidSubs = file.subscriptions.filter((s) => {
      const plan = activePlans.find((p) => p.id === s.id);
      return plan && plan.monthlyUsd > 0;
    });

    let periodStart: Date;
    let periodEnd: Date;
    let daysRemaining: number;

    if (paidSubs.length > 0) {
      // 用最早登記的付費訂閱當基準
      const earliest = paidSubs.reduce((a, b) =>
        new Date(a.addedAt) < new Date(b.addedAt) ? a : b,
      );
      const cycle = this.registry.getBillingCycle(earliest);
      periodStart = cycle.periodStart;
      periodEnd = cycle.periodEnd;
      daysRemaining = cycle.daysRemaining;
    } else {
      // 沒有付費訂閱 → 日曆月
      const now = new Date();
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      daysRemaining = Math.ceil((periodEnd.getTime() - now.getTime()) / 86400000);
    }

    const periodLabel = `${fmtDate(periodStart)} → ${fmtDate(periodEnd)}`;
    const log = await this.readLog();
    const inPeriod = log.filter((e) => {
      const t = new Date(e.timestamp).getTime();
      return t >= periodStart.getTime() && t < periodEnd.getTime();
    });

    let totalUsd = 0;
    let freeOps = 0;
    let paidOps = 0;
    let blocked = 0;
    const byOp: Record<string, { count: number; estimatedUsd: number }> = {};

    for (const e of inPeriod) {
      if (!byOp[e.operation]) byOp[e.operation] = { count: 0, estimatedUsd: 0 };
      byOp[e.operation]!.count++;
      if (!e.allowed) {
        blocked++;
        continue;
      }
      if (e.isFree) {
        freeOps++;
        continue;
      }
      paidOps++;
      totalUsd += Math.max(0, e.estimatedUsd);
      byOp[e.operation]!.estimatedUsd += Math.max(0, e.estimatedUsd);
    }

    return {
      periodLabel,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      daysRemaining,
      totalEstimatedUsd: totalUsd,
      freeOperations: freeOps,
      paidOperations: paidOps,
      blockedOperations: blocked,
      byOperation: byOp,
    };
  }

  // ── 相容層：舊 API 對映到新 API（供 cli.ts / mcp/server.ts 使用）─

  /** 快速守衛：tavily_search（含記錄）*/
  async gateTavily(callCount = 1): Promise<boolean> {
    return this.gate("tavily_search", { callCount });
  }

  /** 快速守衛：內部計算（永遠放行，僅記錄）*/
  async gateInternal(): Promise<boolean> {
    return this.gate("internal_compute");
  }

  /** 計費模式一行摘要 */
  async getBillingInfo(): Promise<string> {
    const file = await this.registry.load();
    const plans = await this.registry.getActivePlans();
    const paidPlans = plans.filter((p) => p.monthlyUsd > 0);
    const apiPlans = plans.filter((p) => p.isApiKeyMode);

    if (paidPlans.length === 0 && apiPlans.length === 0) {
      return "計費模式：僅零成本操作（尚未登記任何訂閱）";
    }
    const parts: string[] = [];
    for (const p of paidPlans) {
      const sub = file.subscriptions.find((s) => s.id === p.id);
      if (!sub) continue;
      const cycle = this.registry.getBillingCycle(sub);
      parts.push(`${p.displayName}（每月 ${cycle.cycleDay} 日重置，剩 ${cycle.daysRemaining} 天）`);
    }
    for (const p of apiPlans) {
      if (!paidPlans.find((x) => x.id === p.id)) {
        parts.push(`${p.displayName}（per-token）`);
      }
    }
    return `計費模式：${parts.join("、")}`;
  }

  // ── 公開 registry（供 CLI 使用）────────────────────────────────

  get subscriptions(): SubscriptionRegistry {
    return this.registry;
  }
}

// ─── 工廠函數 ────────────────────────────────────────────────────────

export function createCostGuard(stateDir: string): CostGuard {
  return new CostGuard(stateDir);
}
