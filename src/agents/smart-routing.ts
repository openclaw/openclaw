/**
 * Smart Model Routing — hybrid message complexity classifier.
 *
 * Two-phase classification:
 * 1. Fast regex scoring (<1ms, zero cost) for high-confidence cases
 * 2. Optional lightweight LLM call for ambiguous messages (hybrid mode)
 *
 * Multi-signal scoring system considers: message length, code indicators,
 * question depth, task verbs, structural complexity, and conversation cues.
 *
 * @see https://github.com/openclaw/openclaw/issues/53516
 */

import type { OpenClawConfig } from "../config/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("smart-routing");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComplexityTier = "simple" | "medium" | "complex";

export type ClassificationResult = {
  tier: ComplexityTier;
  confidence: "high" | "low";
  score: number;
  reason: string;
  method: "pattern" | "llm";
};

export type SmartRoutingOverride = {
  model: string;
  tier: ComplexityTier;
  classification: ClassificationResult;
} | null;

/**
 * Async classifier function for the LLM fallback in hybrid mode.
 * Injected by the caller so smart-routing.ts stays pure (no API deps).
 */
export type LlmClassifierFn = (params: {
  prompt: string;
  timeoutMs: number;
}) => Promise<ComplexityTier | null>;

// ---------------------------------------------------------------------------
// Multi-signal scoring
// ---------------------------------------------------------------------------

type Signal = {
  name: string;
  /** Positive = complex, negative = simple. Magnitude = confidence. */
  score: number;
};

/**
 * Score a message across multiple signals. Returns a composite score where:
 *   score < -2  → simple (high confidence)
 *   -2 ≤ score ≤ 2 → ambiguous (low confidence, needs LLM in hybrid mode)
 *   score > 2   → complex (high confidence)
 *
 * Medium sits between -2 and 2 or when explicitly signalled.
 */
export function scoreMessage(message: string): { signals: Signal[]; total: number } {
  const trimmed = message.trim();
  const signals: Signal[] = [];

  // ── Length signal ──────────────────────────────────────────────────
  const len = trimmed.length;
  if (len === 0) {
    signals.push({ name: "empty", score: -5 });
  } else if (len <= 15) {
    signals.push({ name: "very_short", score: -3 });
  } else if (len <= 50) {
    signals.push({ name: "short", score: -1 });
  } else if (len > 500) {
    signals.push({ name: "long", score: 5 });
  } else if (len > 200) {
    signals.push({ name: "medium_long", score: 1 });
  }

  // ── Word count signal ─────────────────────────────────────────────
  const words = trimmed.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  if (wordCount <= 3) {
    signals.push({ name: "few_words", score: -2 });
  } else if (wordCount >= 30) {
    signals.push({ name: "many_words", score: 2 });
  }

  // ── Code indicators ───────────────────────────────────────────────
  if (/```[\s\S]{10,}/.test(trimmed)) {
    signals.push({ name: "code_block", score: 4 });
  } else if (/`[^`]{5,}`/.test(trimmed)) {
    signals.push({ name: "inline_code", score: 1 });
  }
  // Technical tokens: file paths, camelCase, snake_case, method calls
  const techTokens = (trimmed.match(/[a-z][A-Z]|[a-z]_[a-z]|\w+\.\w+\(|\/\w+\/\w+|=>|->|\$\{/g) || []).length;
  if (techTokens >= 3) {
    signals.push({ name: "tech_density", score: 2 });
  } else if (techTokens >= 1) {
    signals.push({ name: "tech_hint", score: 1 });
  }

  // ── Greeting / acknowledgement patterns ───────────────────────────
  if (/^(hi|hey|hello|yo|sup|hiya|howdy|gday|g'day|morning|evening|afternoon|night|bye|goodbye|cya|later|cheers|thanks|thank you|thx|ty|ta|np|no worries|ok|okay|sure|yep|yup|nope|nah|yes|no|yeah|k|kk|cool|nice|great|awesome|perfect|alright|right|fine|good|lol|haha|heh|wow|omg)\s*[!?.…]*$/i.test(trimmed)) {
    signals.push({ name: "greeting_ack", score: -4 });
  }

  // ── Emoji-only messages ───────────────────────────────────────────
  if (/^[\p{Emoji}\s]+$/u.test(trimmed) && trimmed.length <= 20) {
    signals.push({ name: "emoji_only", score: -4 });
  }

  // ── Slash commands ────────────────────────────────────────────────
  if (/^\/(status|help|new|reset|model|ping|version|reasoning)\s*$/.test(trimmed)) {
    signals.push({ name: "command", score: -5 });
  }

  // ── Complex task verbs ────────────────────────────────────────────
  const complexVerbs = /\b(write|create|build|implement|refactor|debug|fix|review|architect|design|migrate|deploy|integrate|optimize|benchmark|audit)\s+(a |an |the |my |this )?(function|class|module|component|api|endpoint|script|app|service|program|algorithm|test|migration|schema|query|hook|middleware|handler|route|controller|pipeline|workflow|plugin|extension|feature|skill|bot|system|infrastructure|database|codebase|project)\b/i;
  if (complexVerbs.test(trimmed)) {
    signals.push({ name: "complex_task_verb", score: 4 });
  }

  // ── Creative writing requests ─────────────────────────────────────
  if (/\b(write|draft|compose)\s+(a |an |the )?(blog|article|essay|story|report|document|proposal|white paper|documentation|guide|tutorial|readme|spec|rfc)\b/i.test(trimmed)) {
    signals.push({ name: "writing_request", score: 3 });
  }

  // ── Multi-step / reasoning depth ──────────────────────────────────
  if (/\b(step[- ]by[- ]step|compare and contrast|pros and cons|trade-?offs?|deep dive|comprehensive|thorough|detailed|elaborate|in[- ]depth|end[- ]to[- ]end)\b/i.test(trimmed)) {
    signals.push({ name: "reasoning_depth", score: 3 });
  }

  // ── Data analysis / processing ────────────────────────────────────
  if (/\b(analy[sz]e|parse|process|transform|aggregate|correlate|backtest|simulate)\s+(this |the |my )?(data|dataset|csv|json|log|file|table|result|output|metric|performance|report)\b/i.test(trimmed)) {
    signals.push({ name: "data_analysis", score: 3 });
  }

  // ── Code review / PR ──────────────────────────────────────────────
  if (/\b(review|audit|check)\s+(this |the |my )?(pr|pull request|code|commit|diff|changeset|merge request)\b/i.test(trimmed)) {
    signals.push({ name: "code_review", score: 3 });
  }

  // ── Multi-file / cross-cutting ────────────────────────────────────
  if (/\b(across|multiple|all)\s+(files?|modules?|packages?|repos?|services?)\b/i.test(trimmed)) {
    signals.push({ name: "multi_file", score: 3 });
  }

  // ── Translation of substantial content ────────────────────────────
  if (/\b(translate|locali[sz]e)\b/i.test(trimmed) && len > 100) {
    signals.push({ name: "translation_long", score: 3 });
  }

  // ── Architecture / system design ──────────────────────────────────
  if (/\b(architect(ure)?|system design|data model|erd|uml|sequence diagram|class diagram)\b/i.test(trimmed)) {
    signals.push({ name: "architecture", score: 3 });
  }

  // ── Medium-complexity signals ─────────────────────────────────────
  if (/^(how|why|what|when|where|who|which|can you|could you|would you|explain|describe|summarise|summarize|tell me about|help me|show me)\b/i.test(trimmed)) {
    signals.push({ name: "question_opener", score: 0 }); // neutral — needs other signals
  }
  if (/\b(summarise|summarize|rephrase|rewrite|shorten|simplify|expand|clarify|format|convert|list|outline|brainstorm)\b/i.test(trimmed)) {
    signals.push({ name: "moderate_task", score: 1 });
  }
  if (/\b(vs\.?|versus|better|best|recommend|suggest|prefer|choice|option|alternative)\b/i.test(trimmed)) {
    signals.push({ name: "comparison", score: 1 });
  }

  // ── Simple factual question ───────────────────────────────────────
  if (/^(what('s| is) the (time|date|day|weather)|what time|how('s| is) it going|how are you|you there|ping)\s*[?!.]*$/i.test(trimmed)) {
    signals.push({ name: "simple_factual", score: -3 });
  }

  // ── Sentence count (multi-sentence = more complex) ────────────────
  const sentences = trimmed.split(/[.!?]+/).filter((s) => s.trim().length > 5);
  if (sentences.length >= 4) {
    signals.push({ name: "multi_sentence", score: 2 });
  }

  // ── Bullet / numbered list (structured input) ─────────────────────
  const listItems = (trimmed.match(/^[\s]*[-*•\d]+[.)]\s/gm) || []).length;
  if (listItems >= 3) {
    signals.push({ name: "structured_list", score: 2 });
  }

  const total = signals.reduce((sum, s) => sum + s.score, 0);
  return { signals, total };
}

// ---------------------------------------------------------------------------
// Score → Tier mapping
// ---------------------------------------------------------------------------

const SIMPLE_THRESHOLD = -2;
const COMPLEX_THRESHOLD = 2;

export function scoresToTier(
  score: number,
  defaultTier: ComplexityTier = "medium",
): { tier: ComplexityTier; confidence: "high" | "low" } {
  if (score <= SIMPLE_THRESHOLD) {
    return { tier: "simple", confidence: "high" };
  }
  if (score >= COMPLEX_THRESHOLD) {
    return { tier: "complex", confidence: "high" };
  }
  // Ambiguous zone
  if (score < -1) return { tier: "simple", confidence: "low" };
  if (score > 1) return { tier: "complex", confidence: "low" };
  return { tier: defaultTier, confidence: "low" };
}

// ---------------------------------------------------------------------------
// Pattern-only classifier (public for direct use and testing)
// ---------------------------------------------------------------------------

export function classifyMessage(
  message: string,
  defaultTier: ComplexityTier = "medium",
): ClassificationResult {
  const { signals, total } = scoreMessage(message);
  const { tier, confidence } = scoresToTier(total, defaultTier);

  const topSignal = signals.length > 0
    ? signals.reduce((a, b) => (Math.abs(b.score) > Math.abs(a.score) ? b : a))
    : null;

  return {
    tier,
    confidence,
    score: total,
    reason: topSignal
      ? `${topSignal.name} (${topSignal.score > 0 ? "+" : ""}${topSignal.score}), total=${total}`
      : `no signals, total=${total}`,
    method: "pattern",
  };
}

// ---------------------------------------------------------------------------
// Hybrid classifier (pattern + optional LLM fallback)
// ---------------------------------------------------------------------------

export async function classifyMessageHybrid(params: {
  message: string;
  defaultTier?: ComplexityTier;
  llmClassify?: LlmClassifierFn;
  timeoutMs?: number;
}): Promise<ClassificationResult> {
  const defaultTier = params.defaultTier ?? "medium";
  const patternResult = classifyMessage(params.message, defaultTier);

  // High confidence from patterns → skip LLM
  if (patternResult.confidence === "high") {
    return patternResult;
  }

  // No LLM classifier available → return pattern result as-is
  if (!params.llmClassify) {
    return patternResult;
  }

  // Low confidence → try LLM classification
  try {
    const llmTier = await params.llmClassify({
      prompt: params.message,
      timeoutMs: params.timeoutMs ?? 3000,
    });

    if (llmTier) {
      return {
        tier: llmTier,
        confidence: "high",
        score: patternResult.score,
        reason: `llm classified as ${llmTier} (pattern was ${patternResult.tier}, score=${patternResult.score})`,
        method: "llm",
      };
    }
  } catch (err) {
    log.warn(`[smart-routing] LLM classifier failed, falling back to pattern: ${String(err)}`);
  }

  // LLM failed or returned null → use pattern result
  return patternResult;
}

// ---------------------------------------------------------------------------
// LLM classifier prompt (exported for testing / customization)
// ---------------------------------------------------------------------------

export const CLASSIFIER_SYSTEM_PROMPT = `You are a message complexity classifier. Respond with ONLY one word: "simple", "medium", or "complex".

Rules:
- "simple": Greetings, yes/no, short factual questions, acknowledgements, small talk, emoji reactions
- "medium": Explanations, summaries, short code snippets, comparisons, how-to questions, format conversions
- "complex": Code generation, architecture design, multi-step reasoning, deep analysis, long creative writing, data processing, code review, multi-file operations

Consider the task being requested, not just the message length. A short message can request complex work.`;

// ---------------------------------------------------------------------------
// Model resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the smart routing model override for a given message.
 *
 * Returns null if smart routing is disabled or no tier model is configured.
 * When strategy is "hybrid" and llmClassify is provided, ambiguous messages
 * are classified via a lightweight LLM call.
 */
export async function resolveSmartRoutingOverride(params: {
  cfg: OpenClawConfig;
  prompt: string;
  sessionKey?: string;
  llmClassify?: LlmClassifierFn;
}): Promise<SmartRoutingOverride> {
  const routing = params.cfg.smartRouting;
  if (!routing?.enabled) {
    return null;
  }

  // Check session exclusions
  if (params.sessionKey && routing.excludeSessionKeys?.length) {
    for (const pattern of routing.excludeSessionKeys) {
      if (matchGlob(pattern, params.sessionKey)) {
        return null;
      }
    }
  }

  const defaultTier = routing.defaultTier ?? "medium";
  const strategy = routing.strategy ?? "pattern";

  let classification: ClassificationResult;

  if (strategy === "hybrid" && params.llmClassify) {
    classification = await classifyMessageHybrid({
      message: params.prompt,
      defaultTier,
      llmClassify: params.llmClassify,
      timeoutMs: routing.classifierTimeoutMs ?? 3000,
    });
  } else {
    classification = classifyMessage(params.prompt, defaultTier);
  }

  const tierModel = routing.tiers?.[classification.tier];
  if (!tierModel) {
    if (routing.logDecisions !== false) {
      log.info(
        `[smart-routing] tier=${classification.tier} (${classification.reason}) — no model configured for tier, skipping`,
      );
    }
    return null;
  }

  if (routing.logDecisions !== false) {
    log.info(
      `[smart-routing] ${classification.method}:${classification.tier} confidence=${classification.confidence} score=${classification.score} → ${tierModel} (${classification.reason})`,
    );
  }

  return {
    model: tierModel,
    tier: classification.tier,
    classification,
  };
}

// ---------------------------------------------------------------------------
// Correction tracking — logs when user manually switches model after routing
// ---------------------------------------------------------------------------

/**
 * Record a routing correction event (user manually switched model via /model).
 * This provides an implicit feedback signal for tuning the classifier.
 */
export function recordRoutingCorrection(params: {
  sessionKey: string;
  routedTier: ComplexityTier;
  routedModel: string;
  correctedModel: string;
  prompt: string;
}): void {
  log.info(
    `[smart-routing] CORRECTION session=${params.sessionKey} ` +
    `routed=${params.routedTier}→${params.routedModel} ` +
    `corrected→${params.correctedModel} ` +
    `prompt="${params.prompt.slice(0, 80)}"`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple glob matcher supporting * and ** wildcards. */
function matchGlob(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^:]*")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
