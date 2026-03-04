/**
 * Build financial context string for the before_prompt_build hook.
 * Injected into every agent prompt so the LLM is aware of current financial state
 * and can make autonomous lifecycle decisions via HEARTBEAT.md + fin_* tools.
 */

export interface PromptContextDeps {
  paperEngine?: {
    listAccounts?: () => Array<{ id: string; equity?: number }>;
  };
  strategyRegistry?: {
    list?: () => Array<{
      id: string;
      name?: string;
      level?: string;
      lastBacktest?: { sharpe?: number; totalReturn?: number };
    }>;
  };
  riskController?: {
    getCurrentLevel?: () => string;
  };
  exchangeRegistry?: {
    listExchanges?: () => Array<{ id: string; exchange?: string }>;
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
      for (const s of strategies) {
        const level = s.level ?? "L0_INCUBATE";
        const key = level === "KILLED" ? "KILLED" : level.substring(0, 2);
        if (key in byLevel) byLevel[key]++;
        if (level === "L1_BACKTEST" && !s.lastBacktest) needsBacktest++;
      }
      parts.push(
        `Strategies: L0=${byLevel.L0} L1=${byLevel.L1} L2=${byLevel.L2} L3=${byLevel.L3} KILLED=${byLevel.KILLED}`,
      );

      // Surface actionable items so LLM knows what needs attention
      const flags: string[] = [];
      if (byLevel.L0 > 0) flags.push(`${byLevel.L0} at L0 (promote via fin_fund_rebalance)`);
      if (needsBacktest > 0) flags.push(`${needsBacktest} L1 need backtest (use fin_backtest_run)`);
      if (flags.length > 0) parts.push(`Attention: ${flags.join(", ")}`);
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

  if (parts.length === 0) return "";

  return ["Financial Context:", ...parts].join("\n");
}
