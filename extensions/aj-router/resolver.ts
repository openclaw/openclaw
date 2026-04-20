/**
 * Resolver: given a prompt + optional sensitivity label, pick a concrete
 * `provider/model` reference.
 *
 * Pipeline (in order):
 *   1. Classify the prompt (heuristic in v1).
 *   2. Map tier → alias via `classificationRules`.
 *   3. Resolve alias → candidate model ref via `aliases`.
 *   4. Apply sensitivity gate. If gate forces an alias or rejects, honor it.
 *   5. If confidence < `escalationThreshold`, bump one rung up the ladder
 *      (simple → medium → complex). Re-run the sensitivity gate on the
 *      escalated candidate.
 *
 * The resolver is pure — all I/O (logging, hook response) lives in `index.ts`.
 */

import { classifyHeuristic, type Classification } from "./classifier.js";
import type { ClassifierTier, RouterConfig } from "./config.js";
import { evaluate as evaluateSensitivity } from "./sensitivity.js";

const ESCALATION_LADDER: readonly ClassifierTier[] = ["simple", "medium", "complex"];

export type RouteDecision = {
  /** Final concrete `provider/model` reference the agent should use. */
  modelRef: string;
  /** Alias that produced `modelRef` (useful for logs). */
  alias: string;
  /** Classifier output. */
  classification: Classification;
  /** Sensitivity label applied (after defaults). */
  sensitivity: string;
  /** True if escalation bumped the tier one rung up. */
  escalated: boolean;
  /** Ordered list of human-readable decisions that led here. */
  trail: string[];
};

export type RouteFailure = {
  /** True when no model could be chosen. */
  rejected: true;
  reason: string;
  classification: Classification;
  sensitivity: string;
  trail: string[];
};

export type RouteResult = RouteDecision | RouteFailure;

export function isRejection(result: RouteResult): result is RouteFailure {
  return "rejected" in result && result.rejected;
}

export type ResolveParams = {
  config: RouterConfig;
  prompt: string;
  sensitivity?: string;
  /**
   * Optional classifier override (used by `/router explain` to reuse a
   * previous classification, and by tests to inject deterministic output).
   */
  classificationOverride?: Classification;
};

function tierOneUp(tier: ClassifierTier): ClassifierTier | undefined {
  const idx = ESCALATION_LADDER.indexOf(tier);
  if (idx === -1 || idx >= ESCALATION_LADDER.length - 1) {
    return undefined;
  }
  return ESCALATION_LADDER[idx + 1];
}

function resolveAliasRef(config: RouterConfig, alias: string): string | undefined {
  return config.aliases[alias];
}

/** Resolve a prompt to a concrete model reference. */
export function resolve(params: ResolveParams): RouteResult {
  const { config, prompt } = params;
  const sensitivity = params.sensitivity ?? config.defaultSensitivity;
  const trail: string[] = [];

  const classification = params.classificationOverride ?? classifyHeuristic({ prompt });
  trail.push(
    `classified as ${classification.tier} (conf ${classification.confidence.toFixed(2)}): ${classification.reason}`,
  );

  // Start tier = classifier output.
  let tier: ClassifierTier = classification.tier;

  // Escalate if low confidence.
  let escalated = false;
  if (classification.confidence < config.escalationThreshold) {
    const bumped = tierOneUp(tier);
    if (bumped) {
      trail.push(
        `confidence ${classification.confidence.toFixed(2)} < threshold ${config.escalationThreshold}; escalating ${tier} → ${bumped}`,
      );
      tier = bumped;
      escalated = true;
    }
  }

  const alias = config.classificationRules[tier];
  if (!alias) {
    return {
      rejected: true,
      reason: `no alias mapped for tier '${tier}'`,
      classification,
      sensitivity,
      trail,
    };
  }
  trail.push(`tier ${tier} → alias '${alias}'`);

  const candidateRef = resolveAliasRef(config, alias);
  if (!candidateRef) {
    return {
      rejected: true,
      reason: `alias '${alias}' is not defined in aliases map`,
      classification,
      sensitivity,
      trail,
    };
  }
  trail.push(`alias '${alias}' → '${candidateRef}'`);

  const decision = evaluateSensitivity({
    config,
    sensitivity,
    candidateModelRef: candidateRef,
  });

  if (decision.kind === "reject") {
    trail.push(`sensitivity reject: ${decision.reason}`);
    return {
      rejected: true,
      reason: decision.reason,
      classification,
      sensitivity,
      trail,
    };
  }

  if (decision.kind === "force-alias") {
    const forcedRef = resolveAliasRef(config, decision.alias);
    if (!forcedRef) {
      return {
        rejected: true,
        reason: `sensitivity forced alias '${decision.alias}' missing from aliases map`,
        classification,
        sensitivity,
        trail,
      };
    }
    trail.push(`sensitivity override: ${decision.reason}`);
    trail.push(`forced alias '${decision.alias}' → '${forcedRef}'`);
    return {
      modelRef: forcedRef,
      alias: decision.alias,
      classification,
      sensitivity,
      escalated,
      trail,
    };
  }

  return {
    modelRef: candidateRef,
    alias,
    classification,
    sensitivity,
    escalated,
    trail,
  };
}
