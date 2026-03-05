/**
 * Build financial context string for the before_prompt_build hook.
 * Injected into every agent prompt so the LLM is aware of current financial state
 * and can make autonomous lifecycle decisions via HEARTBEAT.md + fin_* tools.
 */

export interface PromptContextDeps {
  paperEngine?: {
    listAccounts?: () => Array<{ id: string; equity?: number }>;
    getAccountState?: (id: string) => { equity: number; initialCapital: number } | null;
  };
  strategyRegistry?: {
    list?: (filter?: { level?: string }) => Array<{
      id: string;
      name?: string;
      level?: string;
      lastBacktest?: {
        sharpe?: number;
        totalReturn?: number;
        maxDrawdown?: number;
        totalTrades?: number;
      };
      lastWalkForward?: { passed?: boolean };
    }>;
  };
  riskController?: {
    getCurrentLevel?: () => string;
  };
  exchangeRegistry?: {
    listExchanges?: () => Array<{ id: string; exchange?: string }>;
  };
  eventStore?: {
    listEvents?: (filter?: {
      type?: string;
    }) => Array<{ type: string; title: string; detail: string }>;
  };
  lifecycleEngine?: {
    getStats?: () => {
      running: boolean;
      cycleCount: number;
      pendingApprovals: number;
    };
  };
}

export function buildFinancialContext(deps: PromptContextDeps): string {
  const parts: string[] = [];

  // 1. Paper engine summary
  try {
    const accounts = deps.paperEngine?.listAccounts?.() ?? [];
    if (accounts.length > 0) {
      const totalEquity = accounts.reduce((sum, a) => sum + (a.equity ?? 0), 0);
      parts.push(`Paper accounts: ${accounts.length}, Total equity: $${totalEquity.toFixed(2)}`);
    }
  } catch {
    // silent
  }

  // 2. Strategy distribution + lifecycle attention flags
  try {
    const strategies = deps.strategyRegistry?.list?.() ?? [];
    if (strategies.length > 0) {
      const byLevel: Record<string, number> = { L0: 0, L1: 0, L2: 0, L3: 0, KILLED: 0 };
      let needsBacktest = 0;
      let needsWalkForward = 0;
      const promotionCandidates: string[] = [];
      for (const s of strategies) {
        const level = s.level ?? "L0_INCUBATE";
        const key = level === "KILLED" ? "KILLED" : level.substring(0, 2);
        if (key in byLevel) byLevel[key]++;
        if (level === "L1_BACKTEST" && !s.lastBacktest) needsBacktest++;
        // Flag L1 with backtest but no walk-forward — needs fin_walk_forward_run
        if (level === "L1_BACKTEST" && s.lastBacktest && !s.lastWalkForward) {
          needsWalkForward++;
        }
        // Only flag as promotion-ready when ALL L1→L2 criteria are met
        if (
          level === "L1_BACKTEST" &&
          s.lastBacktest &&
          s.lastWalkForward?.passed &&
          (s.lastBacktest.sharpe ?? 0) >= 1.0 &&
          (s.lastBacktest.totalTrades ?? 0) >= 100 &&
          Math.abs(s.lastBacktest.maxDrawdown ?? 100) <= 25
        ) {
          promotionCandidates.push(
            `${s.name ?? s.id} (Sharpe ${s.lastBacktest.sharpe?.toFixed(2)}, WF passed)`,
          );
        }
      }
      parts.push(
        `Strategies: L0=${byLevel.L0} L1=${byLevel.L1} L2=${byLevel.L2} L3=${byLevel.L3} KILLED=${byLevel.KILLED}`,
      );

      // Surface actionable items so LLM knows what needs attention
      const flags: string[] = [];
      if (byLevel.L0 > 0) flags.push(`${byLevel.L0} at L0 (promote via fin_fund_rebalance)`);
      if (needsBacktest > 0) flags.push(`${needsBacktest} L1 need backtest (use fin_backtest_run)`);
      if (needsWalkForward > 0)
        flags.push(`${needsWalkForward} L1 need walk-forward (use fin_walk_forward_run)`);
      if (promotionCandidates.length > 0) {
        flags.push(
          `${promotionCandidates.length} L1 ready for L2 promotion: ${promotionCandidates.join(", ")}`,
        );
      }
      if (flags.length > 0) parts.push(`Attention: ${flags.join("; ")}`);
    }
  } catch {
    // silent
  }

  // 2b. Recent health alerts
  try {
    const allAlerts = deps.eventStore?.listEvents?.({ type: "alert_triggered" }) ?? [];
    const recentAlerts = allAlerts.slice(0, 5);
    if (recentAlerts.length > 0) {
      parts.push(`Recent alerts: ${recentAlerts.map((a) => a.title).join("; ")}`);
    }
  } catch {
    // silent
  }

  // 3. Risk status
  try {
    const riskLevel = deps.riskController?.getCurrentLevel?.() ?? "normal";
    parts.push(`Risk level: ${riskLevel}`);
  } catch {
    parts.push("Risk level: normal");
  }

  // 4. Connected exchanges
  try {
    const exchanges = deps.exchangeRegistry?.listExchanges?.() ?? [];
    const names = exchanges.map((e) => e.exchange ?? e.id).join(", ");
    parts.push(`Exchanges: ${names || "none configured"}`);
  } catch {
    parts.push("Exchanges: none configured");
  }

  // 5. Lifecycle engine status
  try {
    const engineStats = deps.lifecycleEngine?.getStats?.();
    if (engineStats) {
      const status = engineStats.running ? "running" : "stopped";
      parts.push(
        `Lifecycle engine: ${status}, cycles=${engineStats.cycleCount}, pending_approvals=${engineStats.pendingApprovals}`,
      );
      if (engineStats.pendingApprovals > 0) {
        parts.push(`ACTION: ${engineStats.pendingApprovals} strategies awaiting L3 approval`);
      }
    }
  } catch {
    // silent
  }

  if (parts.length === 0) return "";

  return ["Financial Context:", ...parts].join("\n");
}
