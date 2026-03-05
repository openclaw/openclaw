/**
 * IdeationEngine — builds structured prompts from MarketSnapshot data
 * and triggers LLM wake via AgentWakeBridge to generate strategy hypotheses.
 *
 * The LLM agent receives the prompt as a system event, analyzes the market data,
 * and calls fin_strategy_create to instantiate new L0 strategies.
 */

import type { ActivityLogStore } from "../core/activity-log-store.js";
import type { AgentWakeBridge } from "../core/agent-wake-bridge.js";
import { STRATEGY_TEMPLATES } from "../core/strategy-templates.js";
import type { MarketSnapshot, SymbolSnapshot, StrategyHypothesis } from "./types.js";

export interface IdeationEngineDeps {
  wakeBridge?: AgentWakeBridge;
  activityLog?: ActivityLogStore;
}

export class IdeationEngine {
  private deps: IdeationEngineDeps;

  constructor(deps: IdeationEngineDeps) {
    this.deps = deps;
  }

  /**
   * Build a structured prompt from the market snapshot and existing strategies,
   * then wake the LLM agent to analyze and generate hypotheses.
   */
  triggerIdeation(
    snapshot: MarketSnapshot,
    existingStrategyNames: string[],
    maxStrategies: number,
  ): void {
    if (snapshot.symbols.length === 0) {
      this.deps.activityLog?.append({
        category: "ideation",
        action: "ideation_skipped",
        detail: "No market data available — skipping ideation cycle",
      });
      return;
    }

    const prompt = this.buildPrompt(snapshot, existingStrategyNames, maxStrategies);

    this.deps.activityLog?.append({
      category: "ideation",
      action: "ideation_wake",
      detail: `Market scan complete: ${snapshot.symbols.length} symbols analyzed. Waking LLM for strategy ideation.`,
      metadata: {
        symbolCount: snapshot.symbols.length,
        regimeSummary: snapshot.regimeSummary,
        crossMarket: snapshot.crossMarket,
      },
    });

    this.deps.wakeBridge?.onIdeationScanComplete({
      symbolCount: snapshot.symbols.length,
      prompt,
    });
  }

  /** Build the structured prompt for the LLM agent. */
  buildPrompt(
    snapshot: MarketSnapshot,
    existingStrategyNames: string[],
    maxStrategies: number,
  ): string {
    const parts: string[] = [];

    parts.push("# Strategy Ideation — Market Scan Results\n");
    parts.push(`Scan timestamp: ${new Date(snapshot.timestamp).toISOString()}`);
    parts.push(`Symbols analyzed: ${snapshot.symbols.length}\n`);

    // Cross-market summary
    parts.push("## Cross-Market Overview");
    parts.push(`- Crypto bullish: ${snapshot.crossMarket.cryptoBullishPct.toFixed(0)}%`);
    parts.push(`- Equity bullish: ${snapshot.crossMarket.equityBullishPct.toFixed(0)}%`);
    if (snapshot.crossMarket.highVolatilitySymbols.length > 0) {
      parts.push(`- High volatility: ${snapshot.crossMarket.highVolatilitySymbols.join(", ")}`);
    }
    parts.push("");

    // Regime summary
    parts.push("## Market Regime Distribution");
    for (const [regime, symbols] of Object.entries(snapshot.regimeSummary)) {
      parts.push(`- **${regime}**: ${symbols.join(", ")}`);
    }
    parts.push("");

    // Per-symbol table
    parts.push("## Symbol Details");
    parts.push(
      "| Symbol | Market | Regime | Price | 24h% | RSI14 | SMA50/200 | MACD Hist | BB Pos | ATR% |",
    );
    parts.push(
      "|--------|--------|--------|-------|------|-------|-----------|-----------|--------|------|",
    );
    for (const s of snapshot.symbols) {
      parts.push(formatSymbolRow(s));
    }
    parts.push("");

    // Available templates
    parts.push("## Available Strategy Templates");
    for (const t of STRATEGY_TEMPLATES) {
      const params = t.parameters
        .filter((p) => p.type === "number" && p.min !== undefined)
        .map((p) => `${p.name}[${p.min}-${p.max}]`)
        .join(", ");
      parts.push(`- **${t.id}** (${t.category}): ${t.description}. Params: ${params}`);
    }
    parts.push("");

    // Existing strategies
    if (existingStrategyNames.length > 0) {
      parts.push("## Existing Strategies (DO NOT duplicate)");
      for (const name of existingStrategyNames) {
        parts.push(`- ${name}`);
      }
      parts.push("");
    }

    // Instructions
    parts.push("## Instructions");
    parts.push(
      `Generate up to ${maxStrategies} new strategy hypotheses based on the market data above.`,
    );
    parts.push("Match regime to strategy type:");
    parts.push(
      "- Bull/bear regimes → trend-following strategies (sma-crossover, trend-following-momentum)",
    );
    parts.push(
      "- Sideways regime → mean-reversion strategies (rsi-mean-reversion, bollinger-bands)",
    );
    parts.push(
      "- Volatile regime → volatility strategies (volatility-mean-reversion) or regime-adaptive",
    );
    parts.push("- Crisis regime → conservative or skip");
    parts.push("");
    parts.push("For each hypothesis, call `fin_strategy_create` with:");
    parts.push("- templateId: one of the template IDs above");
    parts.push("- symbol: from the scanned symbols");
    parts.push("- timeframe: appropriate for the strategy (e.g., 1h, 4h, 1d)");
    parts.push("- parameters: within the documented ranges");
    parts.push("- A descriptive name explaining the rationale");
    parts.push("");
    parts.push("Focus on the highest-confidence opportunities where regime and indicators align.");

    return parts.join("\n");
  }
}

/** Format a SymbolSnapshot as a markdown table row. */
function formatSymbolRow(s: SymbolSnapshot): string {
  const { indicators: ind } = s;
  const smaRatio = ind.sma200 > 0 ? (ind.sma50 / ind.sma200).toFixed(2) : "N/A";
  return (
    `| ${s.symbol} | ${s.market} | ${s.regime} ` +
    `| ${s.price.toFixed(2)} | ${s.change24hPct.toFixed(1)}% ` +
    `| ${ind.rsi14.toFixed(0)} | ${smaRatio} ` +
    `| ${ind.macdHistogram.toFixed(4)} | ${ind.bbPosition.toFixed(2)} ` +
    `| ${ind.atr14Pct.toFixed(1)}% |`
  );
}
