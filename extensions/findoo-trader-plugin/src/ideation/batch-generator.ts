/**
 * BatchHypothesisGenerator: generates multiple parameter variations per template.
 * Used by the Alpha Factory to produce a diverse set of strategy hypotheses
 * for screening and backtesting.
 */

import type { MarketSnapshot, StrategyHypothesis } from "./types.js";

interface StrategyTemplateLike {
  id: string;
  category: string;
  parameters: Array<{ name: string; type: string; min?: number; max?: number; default?: number }>;
  supportedMarkets: string[];
}

const MAX_HYPOTHESES = 50;

// Regime → template category mapping
const REGIME_CATEGORY_MAP: Record<string, string[]> = {
  bull: ["trend", "momentum"],
  bear: ["trend", "momentum"],
  sideways: ["mean-reversion", "volatility"],
  volatile: ["volatility", "momentum"],
  crisis: ["mean-reversion"],
};

export class BatchHypothesisGenerator {
  constructor(private samplesPerTemplate = 3) {}

  generate(snapshot: MarketSnapshot, templates: StrategyTemplateLike[]): StrategyHypothesis[] {
    const hypotheses: StrategyHypothesis[] = [];

    for (const template of templates) {
      if (template.id === "custom") continue;

      const matchingSymbols = this.findMatchingSymbols(snapshot, template);
      if (matchingSymbols.length === 0) continue;

      for (const sym of matchingSymbols) {
        for (let i = 0; i < this.samplesPerTemplate; i++) {
          if (hypotheses.length >= MAX_HYPOTHESES) return hypotheses;

          const parameters = this.sampleParameters(template);
          hypotheses.push({
            templateId: template.id,
            symbol: sym,
            timeframe: "1h",
            parameters,
            rationale: `Auto-generated variation ${i + 1} of ${template.id} for ${sym}`,
            confidence: 0.5,
          });
        }
      }
    }

    return hypotheses;
  }

  private findMatchingSymbols(snapshot: MarketSnapshot, template: StrategyTemplateLike): string[] {
    const matched: string[] = [];

    for (const sym of snapshot.symbols) {
      const categories = REGIME_CATEGORY_MAP[sym.regime] ?? ["multi-factor"];
      if (categories.includes(template.category) || template.category === "multi-factor") {
        matched.push(sym.symbol);
      }
    }

    return matched;
  }

  private sampleParameters(template: StrategyTemplateLike): Record<string, number> {
    const params: Record<string, number> = {};

    for (const p of template.parameters) {
      if (p.type !== "number") continue;
      const min = p.min ?? 1;
      const max = p.max ?? 100;
      const defaultVal = p.default ?? min;
      // Uniform random in [min, max]
      params[p.name] = min + Math.random() * (max - min);
      // Round to reasonable precision
      params[p.name] = Math.round(params[p.name] * 100) / 100;
    }

    return params;
  }
}
