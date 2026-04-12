/**
 * Integration layer: how the DreamingBudgetEnforcer plugs into the existing
 * dreaming pipeline in dreaming.ts.
 *
 * This file demonstrates the exact modifications needed to the
 * `runShortTermDreamingPromotionIfTriggered()` function and the
 * `runDreamingSweepPhases()` call path. In a real PR these changes would
 * be made inline in dreaming.ts and dreaming-phases.ts.
 *
 * ─── Integration Point 1: Cycle initialization (dreaming.ts) ──────────
 *
 * At the top of `runShortTermDreamingPromotionIfTriggered()`, after
 * resolving the dreaming config, instantiate the enforcer:
 *
 *   import { DreamingBudgetEnforcer } from "./dreaming-budget.js";
 *
 *   const enforcer = new DreamingBudgetEnforcer({
 *     config: {
 *       maxCostUsd: dreamingConfig.budget?.maxCostUsd,
 *       windowMs:   dreamingConfig.budget?.windowMs,
 *       minConfidence: dreamingConfig.budget?.minConfidence,
 *       minRecalls:    dreamingConfig.budget?.minRecalls,
 *     },
 *     logger,
 *     workspaceDir: workspaces[0] ?? workspaceDir,
 *   });
 *   await enforcer.loadState();
 *
 * ─── Integration Point 2: Per-workspace loop guard (dreaming.ts) ──────
 *
 * In the workspace iteration loop, before processing each workspace:
 *
 *   for (const ws of workspaces) {
 *     if (enforcer.isBudgetExceeded()) {
 *       logger.warn(`memory-core: skipping workspace ${ws} — budget exceeded`);
 *       break;
 *     }
 *     // ... existing sweep/rank/promote/narrative logic ...
 *   }
 *
 * ─── Integration Point 3: Candidate filtering (dreaming.ts) ──────────
 *
 * After `rankShortTermPromotionCandidates()` returns, filter candidates
 * through the enforcer before promotion and narrative generation:
 *
 *   const rawCandidates = await rankShortTermPromotionCandidates({ ... });
 *   const candidates = rawCandidates.filter((c) => {
 *     const decision = enforcer.checkCandidate({
 *       confidence: c.score,
 *       recallCount: c.recallCount,
 *       snippet: c.snippet,
 *     });
 *     if (!decision.allowed) {
 *       if (verboseLogging) {
 *         logger.info(
 *           `memory-core: skipped candidate "${c.snippet.slice(0, 40)}..." — ${decision.reason}`,
 *         );
 *       }
 *       return false;
 *     }
 *     return true;
 *   });
 *
 * ─── Integration Point 4: Post-narrative cost recording (dreaming.ts) ─
 *
 * After `generateAndAppendDreamNarrative()` completes successfully:
 *
 *   await generateAndAppendDreamNarrative({ ... });
 *   enforcer.recordSessionCost();
 *
 * ─── Integration Point 5: Cycle teardown (dreaming.ts) ────────────────
 *
 * At the end of `runShortTermDreamingPromotionIfTriggered()`, persist
 * the budget state so it survives restarts:
 *
 *   await enforcer.saveState();
 *
 * ─── Integration Point 6: Config schema (openclaw.plugin.json) ────────
 *
 * Add to the dreaming config schema:
 *
 *   "budget": {
 *     "type": "object",
 *     "additionalProperties": false,
 *     "properties": {
 *       "maxCostUsd":    { "type": "number", "minimum": 0 },
 *       "windowMs":      { "type": "integer", "minimum": 60000 },
 *       "minConfidence": { "type": "number", "minimum": 0, "maximum": 1 },
 *       "minRecalls":    { "type": "integer", "minimum": 0 }
 *     }
 *   }
 */

import type { DreamingBudgetEnforcer, CandidateQualityInfo, EnforcerDecision } from "./dreaming-budget.js";

// ── Type augmentation for dreaming config ────────────────────────────

export type DreamingBudgetPluginConfig = {
  budget?: {
    maxCostUsd?: number;
    windowMs?: number;
    minConfidence?: number;
    minRecalls?: number;
  };
};

// ── Helper: filter candidates through the enforcer ───────────────────

export type RankedCandidate = {
  key: string;
  snippet: string;
  score: number;
  recallCount: number;
  uniqueQueries: number;
  [key: string]: unknown;
};

export type FilterResult = {
  passed: RankedCandidate[];
  skipped: {
    duplicate: number;
    lowQuality: number;
    budgetExceeded: number;
  };
};

/**
 * Filter ranked promotion candidates through the enforcer's three-layer
 * safety checks. Returns the candidates that passed and a breakdown of
 * skip reasons.
 */
export function filterCandidatesThroughEnforcer(
  candidates: RankedCandidate[],
  enforcer: DreamingBudgetEnforcer,
  nowMs?: number,
): FilterResult {
  const result: FilterResult = {
    passed: [],
    skipped: { duplicate: 0, lowQuality: 0, budgetExceeded: 0 },
  };

  for (const candidate of candidates) {
    const decision = enforcer.checkCandidate(
      {
        confidence: candidate.score,
        recallCount: candidate.recallCount,
        snippet: candidate.snippet,
      },
      nowMs,
    );

    if (decision.allowed) {
      result.passed.push(candidate);
    } else {
      const reason = decision.reason;
      if (reason === "budget_exceeded") {
        result.skipped.budgetExceeded += 1;
      } else if (reason === "low_quality") {
        result.skipped.lowQuality += 1;
      } else {
        result.skipped.duplicate += 1;
      }
    }
  }

  return result;
}
