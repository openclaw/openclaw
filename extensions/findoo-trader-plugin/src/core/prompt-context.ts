/**
 * Build financial context string for the before_prompt_build hook.
 * Injected into every agent prompt so the LLM is aware of current financial state.
 */

export interface PromptContextDeps {
  paperEngine?: {
    listAccounts?: () => Array<{ id: string; equity?: number }>;
  };
  strategyRegistry?: {
    list?: () => Array<{ id: string; level?: string }>;
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

  // 2. Strategy distribution
  try {
    const strategies = deps.strategyRegistry?.list?.() ?? [];
    if (strategies.length > 0) {
      const byLevel: Record<string, number> = { L0: 0, L1: 0, L2: 0, L3: 0 };
      for (const s of strategies) {
        const key = (s.level ?? "L0").substring(0, 2);
        if (key in byLevel) byLevel[key]++;
      }
      parts.push(`Strategies: L0=${byLevel.L0} L1=${byLevel.L1} L2=${byLevel.L2} L3=${byLevel.L3}`);
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
