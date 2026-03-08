import type {
  VentureModule,
  VentureValidationResult,
} from "../../venture-core/src/module-contract.js";
import type { VentureResult } from "../../venture-core/src/result-schema.js";
import type { VentureRunContext } from "../../venture-core/src/run-context.js";
import type { VentureModuleDescriptor } from "../../venture-core/src/types.js";

export type MarketSignal = {
  source: "trends" | "reddit" | "competitor" | "report" | "manual";
  topic: string;
  momentum: number;
  pain: number;
  monetization: number;
};

export type MarketIntelligenceInput = {
  query: string;
  minScore?: number;
  limit?: number;
  signals: MarketSignal[];
};

export type MarketIntelligencePlan = {
  query: string;
  minScore: number;
  limit: number;
  sources: string[];
  signals: MarketSignal[];
};

export type MarketOpportunity = {
  topic: string;
  score: number;
  rationale: string;
  source: MarketSignal["source"];
};

export type MarketIntelligenceOutput = {
  query: string;
  opportunities: MarketOpportunity[];
};

const descriptor: VentureModuleDescriptor = {
  id: "market-intelligence",
  version: "0.1.0",
  title: "Market Intelligence",
  description: "Ranks opportunity signals into actionable niche candidates.",
  capabilities: ["research", "ranking", "opportunity-discovery"],
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function scoreSignal(signal: MarketSignal): number {
  const momentum = clamp01(signal.momentum);
  const pain = clamp01(signal.pain);
  const monetization = clamp01(signal.monetization);
  return Number((momentum * 0.4 + pain * 0.35 + monetization * 0.25).toFixed(4));
}

export const marketIntelligenceModule: VentureModule<
  MarketIntelligenceInput,
  MarketIntelligencePlan,
  MarketIntelligenceOutput
> = {
  descriptor,
  async plan(input: MarketIntelligenceInput, ctx: VentureRunContext): Promise<MarketIntelligencePlan> {
    const minScore = typeof input.minScore === "number" ? clamp01(input.minScore) : 0.55;
    const limit = typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : 10;
    const sources = [...new Set(input.signals.map((s) => s.source))];
    ctx.logger.info("market-intelligence: plan created", {
      runId: ctx.runId,
      query: input.query,
      minScore,
      limit,
      sources,
    });
    return {
      query: input.query.trim(),
      minScore,
      limit,
      sources,
      signals: input.signals,
    };
  },
  async execute(
    plan: MarketIntelligencePlan,
    _ctx: VentureRunContext,
  ): Promise<MarketIntelligenceOutput> {
    const ranked = plan.signals
      .map((signal) => ({
        topic: signal.topic,
        source: signal.source,
        score: scoreSignal(signal),
        rationale: `momentum=${signal.momentum}, pain=${signal.pain}, monetization=${signal.monetization}`,
      }))
      .filter((item) => item.score >= plan.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, plan.limit);

    return {
      query: plan.query,
      opportunities: ranked,
    };
  },
  async validate(output: MarketIntelligenceOutput): Promise<VentureValidationResult> {
    const warnings: string[] = [];
    const errors: string[] = [];
    if (!output.query) {
      errors.push("query_missing");
    }
    if (output.opportunities.length === 0) {
      warnings.push("no_opportunities_found");
    }
    return { ok: errors.length === 0, errors, warnings };
  },
  async report(
    output: MarketIntelligenceOutput,
    validation: VentureValidationResult,
    ctx: VentureRunContext,
  ): Promise<VentureResult> {
    return {
      ok: validation.ok,
      summary: validation.ok
        ? `Found ${output.opportunities.length} ranked opportunities for "${output.query}".`
        : "Market intelligence validation failed.",
      metrics: [
        { key: "opportunity_count", value: output.opportunities.length },
        {
          key: "top_score",
          value: output.opportunities.length > 0 ? output.opportunities[0].score : 0,
        },
      ],
      artifacts: [],
      events: [
        {
          ts: ctx.nowIso(),
          level: validation.ok ? "info" : "warn",
          message: "market_intelligence_report_generated",
          fields: { runId: ctx.runId },
        },
      ],
      warnings: validation.warnings,
      errors: validation.errors,
    };
  },
};
