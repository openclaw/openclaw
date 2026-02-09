/**
 * Model Routing Intelligence
 *
 * Analyzes task complexity heuristics and auto-selects the most cost-effective
 * model tier. Reduces API costs by routing simple tasks to cheaper models.
 *
 * Tiers:
 *   - Haiku:  Simple tasks, <5K predicted tokens (greetings, short Q&A, formatting)
 *   - Sonnet: Medium tasks, 5-50K predicted tokens (code gen, analysis, multi-step)
 *   - Opus:   Complex tasks, >50K predicted tokens or deep reasoning required
 *
 * Override: Per-session model overrides always take precedence.
 */

import type { OpenClawConfig } from "../config/config.js";

export type ModelTier = "haiku" | "sonnet" | "opus";

export type RoutingDecision = {
  tier: ModelTier;
  provider: string;
  model: string;
  reason: string;
  confidence: number; // 0-1
};

export type ModelRoutingConfig = {
  enabled: boolean;
  /** Model mappings per tier */
  tiers: {
    haiku: { provider: string; model: string };
    sonnet: { provider: string; model: string };
    opus: { provider: string; model: string };
  };
  /** Token thresholds for tier selection */
  thresholds: {
    haikuMaxTokens: number;
    sonnetMaxTokens: number;
  };
  /** Override: force a specific tier */
  forceTier?: ModelTier;
};

const DEFAULT_ROUTING_CONFIG: ModelRoutingConfig = {
  enabled: false,
  tiers: {
    haiku: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    sonnet: { provider: "anthropic", model: "claude-sonnet-4-5-20250514" },
    opus: { provider: "anthropic", model: "claude-opus-4-6" },
  },
  thresholds: {
    haikuMaxTokens: 5_000,
    sonnetMaxTokens: 50_000,
  },
};

/** Patterns that suggest complex reasoning tasks (→ Opus) */
const COMPLEX_REASONING_PATTERNS = [
  /\banalyze\b.*\barchitect/i,
  /\brefactor\b.*\bentire\b/i,
  /\baudit\b.*\bsecurity\b/i,
  /\bdesign\b.*\bsystem\b/i,
  /\bmulti.?step\b/i,
  /\bcomplex\b.*\banalysis\b/i,
  /\bdeep\s+dive\b/i,
  /\bcomprehensive\b.*\breview\b/i,
  /\boptimize\b.*\bperformance\b/i,
  /\bcritical\b.*\bthink/i,
];

/** Patterns that suggest simple tasks (→ Haiku) */
const SIMPLE_TASK_PATTERNS = [
  /^(hi|hello|hey|thanks|thank you|ok|yes|no|sure)\b/i,
  /\bwhat\s+time\b/i,
  /\bwhat\s+day\b/i,
  /\bformat\b.*\b(this|text|json)\b/i,
  /\bconvert\b.*\bto\b/i,
  /\bsummarize\b.*\b(in\s+one|briefly)\b/i,
  /\btranslate\b/i,
  /\bspell\s*check\b/i,
  /\bwhat\s+is\b.*\b\?\s*$/i,
];

/** Patterns indicating structured output requests */
const STRUCTURED_OUTPUT_PATTERNS = [
  /\bjson\b/i,
  /\byaml\b/i,
  /\bcsv\b/i,
  /\bmarkdown\s+table\b/i,
  /\bcode\b.*\b(block|snippet|example)\b/i,
];

/**
 * Estimate the predicted output token count based on input characteristics.
 */
export function estimateOutputTokens(params: {
  inputText: string;
  messageHistoryDepth: number;
  hasToolCalls: boolean;
  hasCodeRequest: boolean;
}): number {
  const { inputText, messageHistoryDepth, hasToolCalls, hasCodeRequest } = params;
  const inputLength = inputText.length;

  // Base estimate: ~0.3 tokens per input character for response
  let estimate = Math.max(500, inputLength * 0.3);

  // History depth multiplier: deeper conversations tend to produce longer responses
  if (messageHistoryDepth > 20) {
    estimate *= 1.5;
  } else if (messageHistoryDepth > 10) {
    estimate *= 1.2;
  }

  // Tool calls suggest multi-step work
  if (hasToolCalls) {
    estimate *= 2.0;
  }

  // Code requests tend to be verbose
  if (hasCodeRequest) {
    estimate *= 1.8;
  }

  // Structured output adds overhead
  const hasStructuredOutput = STRUCTURED_OUTPUT_PATTERNS.some((p) => p.test(inputText));
  if (hasStructuredOutput) {
    estimate *= 1.3;
  }

  return Math.round(estimate);
}

/**
 * Analyze task complexity and return a routing decision.
 */
export function analyzeTaskComplexity(params: {
  inputText: string;
  messageHistoryDepth: number;
  hasToolCalls: boolean;
  systemPromptLength: number;
}): {
  tier: ModelTier;
  reason: string;
  confidence: number;
  estimatedTokens: number;
} {
  const { inputText, messageHistoryDepth, hasToolCalls, systemPromptLength } = params;

  const hasCodeRequest =
    /\bcode\b/i.test(inputText) ||
    /\bimplement\b/i.test(inputText) ||
    /\bfunction\b/i.test(inputText) ||
    /\bclass\b/i.test(inputText);

  const estimatedTokens = estimateOutputTokens({
    inputText,
    messageHistoryDepth,
    hasToolCalls,
    hasCodeRequest,
  });

  // Check for complex reasoning patterns first (→ Opus)
  const isComplexReasoning = COMPLEX_REASONING_PATTERNS.some((p) => p.test(inputText));
  if (isComplexReasoning) {
    return {
      tier: "opus",
      reason: "Complex reasoning task detected",
      confidence: 0.85,
      estimatedTokens,
    };
  }

  // Check for simple patterns (→ Haiku)
  const isSimple = SIMPLE_TASK_PATTERNS.some((p) => p.test(inputText));
  if (isSimple && estimatedTokens < 5_000 && messageHistoryDepth < 5) {
    return {
      tier: "haiku",
      reason: "Simple task pattern detected",
      confidence: 0.9,
      estimatedTokens,
    };
  }

  // Short inputs with no tool calls and shallow history → Haiku
  if (inputText.length < 200 && !hasToolCalls && messageHistoryDepth < 3 && !hasCodeRequest) {
    return {
      tier: "haiku",
      reason: "Short input, shallow context",
      confidence: 0.8,
      estimatedTokens,
    };
  }

  // Token-based thresholds
  if (estimatedTokens < 5_000) {
    return {
      tier: "haiku",
      reason: `Estimated ${estimatedTokens} tokens (below 5K threshold)`,
      confidence: 0.7,
      estimatedTokens,
    };
  }

  if (estimatedTokens > 50_000 || (systemPromptLength > 10_000 && hasToolCalls)) {
    return {
      tier: "opus",
      reason: `Estimated ${estimatedTokens} tokens or complex system prompt with tools`,
      confidence: 0.75,
      estimatedTokens,
    };
  }

  // Default to Sonnet for medium complexity
  return {
    tier: "sonnet",
    reason: `Medium complexity, estimated ${estimatedTokens} tokens`,
    confidence: 0.7,
    estimatedTokens,
  };
}

/**
 * Resolve the model routing configuration from OpenClaw config.
 */
export function resolveModelRoutingConfig(cfg: OpenClawConfig): ModelRoutingConfig {
  const routing = (cfg.agents?.defaults as Record<string, unknown>)?.modelRouting as
    | Partial<ModelRoutingConfig>
    | undefined;

  if (!routing) {
    return DEFAULT_ROUTING_CONFIG;
  }

  return {
    enabled: routing.enabled ?? false,
    tiers: {
      haiku: routing.tiers?.haiku ?? DEFAULT_ROUTING_CONFIG.tiers.haiku,
      sonnet: routing.tiers?.sonnet ?? DEFAULT_ROUTING_CONFIG.tiers.sonnet,
      opus: routing.tiers?.opus ?? DEFAULT_ROUTING_CONFIG.tiers.opus,
    },
    thresholds: {
      haikuMaxTokens: routing.thresholds?.haikuMaxTokens ?? 5_000,
      sonnetMaxTokens: routing.thresholds?.sonnetMaxTokens ?? 50_000,
    },
    forceTier: routing.forceTier,
  };
}

/**
 * Route to the optimal model based on task analysis.
 * Returns undefined if routing is disabled or a session override exists.
 */
export function routeModel(params: {
  cfg: OpenClawConfig;
  inputText: string;
  messageHistoryDepth: number;
  hasToolCalls: boolean;
  systemPromptLength: number;
  hasSessionModelOverride: boolean;
}): RoutingDecision | undefined {
  const config = resolveModelRoutingConfig(params.cfg);

  if (!config.enabled) {
    return undefined;
  }

  // Session-level model overrides always take precedence
  if (params.hasSessionModelOverride) {
    return undefined;
  }

  // Forced tier override
  if (config.forceTier) {
    const tierConfig = config.tiers[config.forceTier];
    return {
      tier: config.forceTier,
      ...tierConfig,
      reason: `Forced tier: ${config.forceTier}`,
      confidence: 1.0,
    };
  }

  const analysis = analyzeTaskComplexity({
    inputText: params.inputText,
    messageHistoryDepth: params.messageHistoryDepth,
    hasToolCalls: params.hasToolCalls,
    systemPromptLength: params.systemPromptLength,
  });

  const tierConfig = config.tiers[analysis.tier];
  return {
    tier: analysis.tier,
    ...tierConfig,
    reason: analysis.reason,
    confidence: analysis.confidence,
  };
}

/**
 * Estimate cost savings from model routing.
 * Returns the ratio of routing cost to fixed-opus cost (lower = more savings).
 */
export function estimateCostRatio(params: {
  haikuPercentage: number;
  sonnetPercentage: number;
  opusPercentage: number;
}): number {
  // Approximate cost ratios relative to Opus
  const HAIKU_COST_RATIO = 0.04; // ~25x cheaper than Opus
  const SONNET_COST_RATIO = 0.2; // ~5x cheaper than Opus
  const OPUS_COST_RATIO = 1.0;

  const { haikuPercentage, sonnetPercentage, opusPercentage } = params;
  const total = haikuPercentage + sonnetPercentage + opusPercentage;
  if (total === 0) {
    return 1.0;
  }

  return (
    (haikuPercentage * HAIKU_COST_RATIO +
      sonnetPercentage * SONNET_COST_RATIO +
      opusPercentage * OPUS_COST_RATIO) /
    total
  );
}
