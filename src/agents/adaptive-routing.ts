/**
 * Adaptive cost routing: select models based on task complexity.
 *
 * "Start cheap, escalate on failure" pattern.
 * - Trivial tasks → cheapest model meeting role requirements (worker tier)
 * - Moderate tasks → default role model (existing behavior)
 * - Complex tasks → most capable model available (orchestrator tier)
 *
 * Quality-based escalation detects low-quality responses and recommends
 * retrying with a stronger model (max 1 escalation per request).
 */

import type { OpenClawConfig } from "../config/config.js";
import type { AgentRole } from "../config/types.agents.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import type { ModelCatalogEntry } from "./model-catalog.js";
import type { ModelRef } from "./model-selection.js";
import {
  COST_TIER_ORDER,
  ROLE_REQUIREMENTS,
  rankModelsForRole,
  type RoleRequirements,
} from "./model-auto-select.js";
import { classifyComplexity, type TaskComplexity } from "./task-classifier.js";

/**
 * Map task complexity to role tier for model selection.
 * Trivial tasks use worker requirements (cheapest), complex tasks use orchestrator (best).
 */
const COMPLEXITY_TO_ROLE: Record<TaskComplexity, AgentRole> = {
  trivial: "worker",
  moderate: "specialist",
  complex: "orchestrator",
};

/**
 * Select a model based on both task complexity and agent role.
 *
 * Unlike `selectModelForRole()` which only considers role,
 * this function also considers the task text to determine complexity
 * and may downgrade to a cheaper model for trivial tasks.
 */
export function selectModelForTask(params: {
  task: string;
  role: AgentRole;
  catalog: ModelCatalogEntry[];
  allowedKeys?: Set<string>;
  cfg?: OpenClawConfig;
  authStore?: AuthProfileStore;
}): { ref: ModelRef; complexity: TaskComplexity; downgraded: boolean } | null {
  const { task, role, catalog, allowedKeys, cfg, authStore } = params;
  const complexity = classifyComplexity(task);

  // For complex tasks, prefer the most capable model (highest cost tier + newest).
  if (complexity === "complex") {
    const ranked = rankModelsForRole(catalog, ROLE_REQUIREMENTS[role], allowedKeys, cfg, authStore);
    if (ranked.length > 0) {
      // ranked is sorted cheapest-first; pick last for most capable
      const best = ranked[ranked.length - 1];
      return {
        ref: { provider: best.entry.provider, model: best.entry.id },
        complexity,
        downgraded: false,
      };
    }
    return null;
  }

  // For trivial/moderate tasks, try a cheaper tier first.
  const cheaperRole = COMPLEXITY_TO_ROLE[complexity];
  const cheaperRequirements = ROLE_REQUIREMENTS[cheaperRole];

  // Only downgrade if the cheaper tier is actually cheaper than the role's tier (numeric comparison).
  const roleRequirements = ROLE_REQUIREMENTS[role];
  const isDowngrade =
    COST_TIER_ORDER[cheaperRequirements.maxCostTier] <
    COST_TIER_ORDER[roleRequirements.maxCostTier];

  if (isDowngrade) {
    // Merge: use cheaper cost tier but keep role's capability requirements.
    const mergedRequirements: RoleRequirements = {
      minPerformanceTier: cheaperRequirements.minPerformanceTier,
      requiredCapabilities: roleRequirements.requiredCapabilities,
      maxCostTier: cheaperRequirements.maxCostTier,
    };

    const cheapRanked = rankModelsForRole(catalog, mergedRequirements, allowedKeys, cfg, authStore);
    if (cheapRanked.length > 0) {
      const best = cheapRanked[0];
      return {
        ref: { provider: best.entry.provider, model: best.entry.id },
        complexity,
        downgraded: true,
      };
    }
  }

  // Fallback: use role's default requirements.
  const ranked = rankModelsForRole(catalog, roleRequirements, allowedKeys, cfg, authStore);
  if (ranked.length > 0) {
    const best = ranked[0];
    return {
      ref: { provider: best.entry.provider, model: best.entry.id },
      complexity,
      downgraded: false,
    };
  }

  // Relaxation: allow any cost tier if role's default also fails.
  if (roleRequirements.maxCostTier !== "expensive") {
    const relaxed: RoleRequirements = {
      ...roleRequirements,
      maxCostTier: "expensive",
    };
    const relaxedRanked = rankModelsForRole(catalog, relaxed, allowedKeys, cfg, authStore);
    if (relaxedRanked.length > 0) {
      const best = relaxedRanked[0];
      return {
        ref: { provider: best.entry.provider, model: best.entry.id },
        complexity,
        downgraded: false,
      };
    }
  }

  // Final relaxation: drop all capability/performance requirements.
  const fullyRelaxed: RoleRequirements = {
    minPerformanceTier: "fast",
    requiredCapabilities: [],
    maxCostTier: "expensive",
  };
  const fullyRelaxedRanked = rankModelsForRole(catalog, fullyRelaxed, allowedKeys, cfg, authStore);
  if (fullyRelaxedRanked.length > 0) {
    const best = fullyRelaxedRanked[0];
    return {
      ref: { provider: best.entry.provider, model: best.entry.id },
      complexity,
      downgraded: false,
    };
  }

  return null;
}

// ── Quality-based escalation heuristics ──

/**
 * Signals that suggest a response may be low quality and could benefit
 * from a more capable model.
 */
export type QualitySignals = {
  /** Whether the response contains uncertainty markers. */
  hasUncertainty: boolean;
  /** Whether the response appears truncated or incomplete. */
  appearsIncomplete: boolean;
  /** Response length in characters. */
  responseLength: number;
  /** Task complexity classification. */
  taskComplexity: TaskComplexity;
};

const UNCERTAINTY_PATTERNS = [
  /\bi(?:'m| am) not (?:sure|certain|confident)\b/i,
  /\bi(?:'m| am) unsure\b/i,
  /\bi don(?:'t| not) know\b/i,
  /\bthis (?:may|might) not be (?:correct|right|accurate)\b/i,
  /\bmy (?:knowledge|training) (?:is limited|doesn't cover|may be outdated)\b/i,
  /\bi cannot (?:determine|verify|confirm)\b/i,
];

const INCOMPLETE_PATTERNS = [
  /\.\.\.\s*$/, // trailing ellipsis
  /\b(?:TODO|FIXME|TBD)\b/i, // placeholder markers
  /^\s*\/\/\s*\.\.\.\s*$/m, // comment with just "..."
];

/**
 * Check if a response has an unclosed fenced code block.
 * Counts ``` fences; odd count means the last block is unclosed.
 */
function hasUnclosedCodeBlock(text: string): boolean {
  const fences = text.match(/^```/gm);
  return fences !== null && fences.length % 2 !== 0;
}

/**
 * Analyze a response for quality signals.
 */
export function analyzeResponseQuality(response: string, task: string): QualitySignals {
  const hasUncertainty = UNCERTAINTY_PATTERNS.some((p) => p.test(response));
  const appearsIncomplete =
    hasUnclosedCodeBlock(response) || INCOMPLETE_PATTERNS.some((p) => p.test(response));
  const taskComplexity = classifyComplexity(task);

  return {
    hasUncertainty,
    appearsIncomplete,
    responseLength: response.length,
    taskComplexity,
  };
}

/**
 * Determine if a response should trigger model escalation.
 *
 * Only recommends escalation when:
 * 1. A cheaper model was used (downgraded=true)
 * 2. Quality signals indicate the response is inadequate
 * 3. The task is non-trivial
 */
export function shouldEscalate(params: {
  signals: QualitySignals;
  wasDowngraded: boolean;
}): boolean {
  const { signals, wasDowngraded } = params;

  // Only escalate if we actually used a cheaper model.
  if (!wasDowngraded) {
    return false;
  }

  // Trivial tasks rarely need escalation.
  if (signals.taskComplexity === "trivial") {
    return false;
  }

  // Escalate on uncertainty markers.
  if (signals.hasUncertainty) {
    return true;
  }

  // Escalate on incomplete responses for moderate+ tasks.
  if (signals.appearsIncomplete) {
    return true;
  }

  // Escalate on suspiciously short responses for complex tasks.
  if (signals.taskComplexity === "complex" && signals.responseLength < 200) {
    return true;
  }

  return false;
}
