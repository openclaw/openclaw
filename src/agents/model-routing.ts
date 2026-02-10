import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agent/model-routing");

export type ComplexityLevel = "simple" | "medium" | "complex";

export type ModelRoutingConfig = {
  /** Enable automatic model routing (default: false, opt-in). */
  enabled: boolean;
  /** Model tier mappings. */
  models: {
    simple: string;
    medium: string;
    complex: string;
  };
  /** Use Opus for plan/think mode, Sonnet for execution. */
  opusPlanMode: boolean;
};

const DEFAULT_CONFIG: ModelRoutingConfig = {
  enabled: false,
  models: {
    simple: "anthropic/claude-haiku",
    medium: "anthropic/claude-sonnet-4-5",
    complex: "anthropic/claude-opus-4-6",
  },
  opusPlanMode: false,
};

export function resolveModelRoutingConfig(cfg?: OpenClawConfig): ModelRoutingConfig {
  const raw = cfg?.agents?.defaults as Record<string, unknown> | undefined;
  const routing = raw?.modelRouting as Record<string, unknown> | undefined;

  if (!routing) {
    return DEFAULT_CONFIG;
  }

  const models = routing.models as Record<string, string> | undefined;

  return {
    enabled: typeof routing.enabled === "boolean" ? routing.enabled : DEFAULT_CONFIG.enabled,
    models: {
      simple: typeof models?.simple === "string" ? models.simple : DEFAULT_CONFIG.models.simple,
      medium: typeof models?.medium === "string" ? models.medium : DEFAULT_CONFIG.models.medium,
      complex: typeof models?.complex === "string" ? models.complex : DEFAULT_CONFIG.models.complex,
    },
    opusPlanMode:
      typeof routing.opusPlanMode === "boolean"
        ? routing.opusPlanMode
        : DEFAULT_CONFIG.opusPlanMode,
  };
}

// --- Simple message patterns ---

const GREETING_PATTERNS =
  /^(hi|hello|hey|yo|sup|good\s+(morning|afternoon|evening|night)|howdy|hola|what'?s\s+up)\b/i;

const STATUS_CHECK_PATTERNS =
  /^(status|how\s+are\s+you|what('?re|\s+are)\s+you\s+doing|are\s+you\s+(there|online|awake))\b/i;

const SIMPLE_COMMAND_PATTERNS = /^\/?(help|version|model|think|compact|memory|verbose|status)\b/i;

// --- Complex message patterns ---

const MULTI_STEP_PATTERNS =
  /\b(step\s+\d|first.+then.+finally|multi-?step|multiple\s+(files?|tasks?|changes?))\b/i;

const PLANNING_PATTERNS =
  /\b(plan|architect|design|refactor|restructure|implement.+feature|build.+system|create.+from\s+scratch)\b/i;

const MULTI_TOOL_PATTERNS =
  /\b(search.+and.+(edit|replace|modify|fix|update)|read.+and.+(write|create)|find.+and.+(fix|update|replace))\b/i;

/**
 * Classify message complexity using rule-based heuristics.
 * No LLM call required.
 */
export function classifyComplexity(message: string): ComplexityLevel {
  const trimmed = message.trim();

  // Empty messages are simple
  if (trimmed.length === 0) {
    return "simple";
  }

  // Token count estimate (rough: words * 1.3)
  const wordCount = trimmed.split(/\s+/).length;
  const estimatedTokens = Math.ceil(wordCount * 1.3);

  // Check for complex patterns FIRST (before short-circuiting on length)
  if (MULTI_STEP_PATTERNS.test(trimmed)) {
    return "complex";
  }
  if (PLANNING_PATTERNS.test(trimmed)) {
    return "complex";
  }
  if (MULTI_TOOL_PATTERNS.test(trimmed)) {
    return "complex";
  }

  // Long messages with multiple sentences tend to be complex
  const sentenceCount = trimmed.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;
  if (sentenceCount >= 4 && estimatedTokens > 30) {
    return "complex";
  }

  // Short messages (< 50 tokens) with simple patterns
  if (estimatedTokens < 50) {
    if (GREETING_PATTERNS.test(trimmed)) {
      return "simple";
    }
    if (STATUS_CHECK_PATTERNS.test(trimmed)) {
      return "simple";
    }
    if (SIMPLE_COMMAND_PATTERNS.test(trimmed)) {
      return "simple";
    }
  }

  // Very short messages (< 5 words) default to simple
  if (wordCount < 5) {
    return "simple";
  }

  // Default to medium
  return "medium";
}

export type RoutingDecision = {
  model: string;
  complexity: ComplexityLevel;
  reason: string;
  overridden: boolean;
};

/**
 * Route a message to the appropriate model based on complexity.
 *
 * Priority:
 * 1. Explicit /model override (always wins)
 * 2. Opus plan mode (if enabled and thinking/planning)
 * 3. Automatic complexity classification
 */
export function routeMessage(params: {
  message: string;
  config: ModelRoutingConfig;
  explicitModelOverride?: string;
  isThinkingMode?: boolean;
}): RoutingDecision {
  const { message, config, explicitModelOverride, isThinkingMode } = params;

  // Explicit override always takes precedence
  if (explicitModelOverride) {
    return {
      model: explicitModelOverride,
      complexity: "medium",
      reason: "explicit model override",
      overridden: true,
    };
  }

  // Opus plan mode: use Opus for thinking, Sonnet for execution
  if (config.opusPlanMode && isThinkingMode) {
    return {
      model: config.models.complex,
      complexity: "complex",
      reason: "opus plan mode (thinking/planning)",
      overridden: false,
    };
  }

  const complexity = classifyComplexity(message);
  const model = config.models[complexity];

  log.info(
    `routing decision: complexity=${complexity} model=${model} message_preview="${message.slice(0, 50)}"`,
  );

  return {
    model,
    complexity,
    reason: `auto-classified as ${complexity}`,
    overridden: false,
  };
}
