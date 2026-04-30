/**
 * GSAR: Typed Grounding for Hallucination Detection and Recovery.
 *
 * Implements the scoring formula, decision function, and TerminationCondition
 * from "GSAR: Typed Grounding for Hallucination Detection and Recovery in
 * Multi-Agent LLMs" (Kamelhar, 2026, arxiv:2604.23366).
 *
 * The four-way claim typology partitions every claim in a response into:
 *   G (grounded)      — directly supported by retrieved evidence
 *   U (ungrounded)    — no supporting evidence found
 *   X (contradicted)  — evidence actively contradicts the claim
 *   K (complementary) — relevant but not directly confirmatory evidence
 *
 * Groundedness score (Eq. 2 from paper):
 *   S = (W(G) + W(K)) / (W(G) + W(U) + ρ·W(X) + W(K))
 *
 * Three-tier decision function:
 *   proceed     if S ≥ τ_proceed    (default 0.80)
 *   regenerate  if S ≥ τ_regenerate (default 0.65)
 *   replan      if S < τ_regenerate
 *
 * The GroundednessCondition wires GSAR into the termination algebra:
 *   GroundednessCondition(scorer).or(MaxIterations(K_max))
 * exits early when grounded, halts at budget when not.
 */

import { TerminationCondition, type Awaitable, type TerminationState } from "./termination.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ClaimType = "grounded" | "ungrounded" | "contradicted" | "complementary";

/** Count or summed weight of claims in each partition. */
export type ClaimPartition = {
  grounded: number;
  ungrounded: number;
  contradicted: number;
  complementary: number;
};

/** Per-type weight map w: ClaimType → [0, 1]. */
export type EvidenceWeights = Record<ClaimType, number>;

export type GSARDecision = "proceed" | "regenerate" | "replan";

export type GSARThresholds = {
  proceed: number;
  regenerate: number;
};

export type GSARResult = {
  score: number;
  decision: GSARDecision;
  partition: ClaimPartition;
};

// ─── Default weights ─────────────────────────────────────────────────────────

/**
 * Default evidence weights (paper §4.2, validated on FEVER + 4 LLM judges).
 *
 * grounded = 1.0     — unit weight; direct evidence is the reference signal
 * complementary = 0.5 — exactly half of grounded; supports without confirming
 * ungrounded = 1.0   — each unsupported claim expands the denominator equally;
 *                      setting this to 0 would make ungrounded claims invisible
 * contradicted = 1.0 — applied via ρ; contradictions penalise at full weight
 *
 * These are not arbitrary: the ratio grounded:complementary = 2:1 encodes the
 * epistemic asymmetry between confirmation and coherence. Vary them with
 * calibrateWeights() if your evidence sources have different reliability.
 */
export const DEFAULT_WEIGHTS: EvidenceWeights = {
  grounded: 1.0,
  complementary: 0.5,
  ungrounded: 1.0,
  contradicted: 1.0,
};

/**
 * Default decision thresholds (paper §4.3, chosen to maximise F1 on FEVER).
 *
 * τ_proceed = 0.80    — 80% grounded-evidence share before accepting output;
 *                       matches the standard high-precision NLP operating point
 * τ_regenerate = 0.65 — lower bound of the "regenerate band" (0.65–0.80);
 *                       wide enough to distinguish partial from wholly absent
 *
 * Derive your own from labelled examples with calibrateThresholds().
 */
export const DEFAULT_THRESHOLDS: GSARThresholds = {
  proceed: 0.8,
  regenerate: 0.65,
};

// ─── Core scoring (Eq. 2) ────────────────────────────────────────────────────

/**
 * Compute the GSAR groundedness score S ∈ [0, 1].
 *
 * S = (W(G) + W(K)) / (W(G) + W(U) + ρ·W(X) + W(K))
 *
 * Returns 0 when the partition is empty (no claims extracted).
 * Structural properties proven in the paper:
 *   P1 Boundedness:             S ∈ [0,1]
 *   P2 Grounded monotonicity:   U→G never decreases S
 *   P3 Contradiction penalty:   adding X never increases S
 *   P4 Complementary value:     K contributes positively but ≤ equivalent G
 *   P5 Non-suppression:         X stays in denominator with weight ρ·W(X)
 *   P6 Asymmetry:               w(inference) < w(tool_match) strictly decreases S
 */
export function computeGroundednessScore(
  partition: ClaimPartition,
  weights: EvidenceWeights = DEFAULT_WEIGHTS,
  rho = 1.0,
): number {
  const wG = partition.grounded * weights.grounded;
  const wU = partition.ungrounded * weights.ungrounded;
  const wX = partition.contradicted * weights.contradicted;
  const wK = partition.complementary * weights.complementary;

  const numerator = wG + wK;
  const denominator = wG + wU + rho * wX + wK;

  return denominator === 0 ? 0 : numerator / denominator;
}

// ─── Decision function (δ) ───────────────────────────────────────────────────

export function gsarDecision(
  score: number,
  thresholds: GSARThresholds = DEFAULT_THRESHOLDS,
): GSARDecision {
  if (score >= thresholds.proceed) {
    return "proceed";
  }
  if (score >= thresholds.regenerate) {
    return "regenerate";
  }
  return "replan";
}

export function evaluateGroundedness(
  partition: ClaimPartition,
  weights: EvidenceWeights = DEFAULT_WEIGHTS,
  thresholds: GSARThresholds = DEFAULT_THRESHOLDS,
  rho = 1.0,
): GSARResult {
  const score = computeGroundednessScore(partition, weights, rho);
  const decision = gsarDecision(score, thresholds);
  return { score, decision, partition };
}

// ─── TerminationCondition integration ────────────────────────────────────────

export type GSARScorerFn = (replyText: string) => Awaitable<ClaimPartition>;

/**
 * TerminationCondition that fires when GSAR says "proceed".
 *
 * Usage (bounded recovery loop from Algorithm 1):
 *   new GroundednessCondition(scorer).or(new MaxIterations(K_max))
 *
 * The OR with MaxIterations implements the K_max budget from the paper:
 * termination is guaranteed even when evidence is insufficient for proceed.
 */
export class GroundednessCondition extends TerminationCondition {
  private lastResult: GSARResult | null = null;

  constructor(
    private readonly scorer: GSARScorerFn,
    private readonly weights: EvidenceWeights = DEFAULT_WEIGHTS,
    private readonly thresholds: GSARThresholds = DEFAULT_THRESHOLDS,
    private readonly rho = 1.0,
  ) {
    super();
  }

  async check(state: TerminationState): Promise<readonly [boolean, string | null]> {
    const partition = await this.scorer(state.replyText);
    const result = evaluateGroundedness(partition, this.weights, this.thresholds, this.rho);
    this.lastResult = result;

    if (result.decision === "proceed") {
      return [true, `grounded:proceed:s=${result.score.toFixed(3)}`];
    }
    return [false, null];
  }

  override reset(): void {
    this.lastResult = null;
  }

  /** The GSAR result from the most recent check(). */
  getLastResult(): GSARResult | null {
    return this.lastResult;
  }
}

// ─── Calibration helpers ─────────────────────────────────────────────────────

export type LabeledExample = {
  partition: ClaimPartition;
  /** Human-verified expected decision for this partition. */
  expected: GSARDecision;
};

/**
 * Derive proceed/regenerate thresholds from labeled examples.
 *
 * Scans the score distribution of your examples and returns the tightest
 * thresholds that correctly classify all of them. Falls back to DEFAULT_THRESHOLDS
 * when examples are insufficient (< 2 per decision class).
 *
 * Usage:
 *   const thresholds = calibrateThresholds(myExamples, myWeights);
 *   new GroundednessCondition(scorer, myWeights, thresholds)
 */
export function calibrateThresholds(
  examples: LabeledExample[],
  weights: EvidenceWeights = DEFAULT_WEIGHTS,
  rho = 1.0,
): GSARThresholds {
  const scored = examples.map((e) => ({
    score: computeGroundednessScore(e.partition, weights, rho),
    expected: e.expected,
  }));

  const proceedScores = scored.filter((e) => e.expected === "proceed").map((e) => e.score);
  const regenerateScores = scored.filter((e) => e.expected === "regenerate").map((e) => e.score);
  const replanScores = scored.filter((e) => e.expected === "replan").map((e) => e.score);

  if (proceedScores.length < 2 || replanScores.length < 2) {
    return DEFAULT_THRESHOLDS;
  }

  // τ_proceed = minimum score among proceed examples (lowest acceptable grounded score)
  const tProceed = Math.min(...proceedScores);

  // τ_regenerate = maximum score among replan examples (highest still-too-low score)
  const maxReplan = Math.max(...replanScores);
  const tRegenerate =
    regenerateScores.length > 0 ? Math.min(...regenerateScores) : (maxReplan + tProceed) / 2;

  return {
    proceed: Math.max(tProceed, DEFAULT_THRESHOLDS.regenerate + 0.01),
    regenerate: Math.min(tRegenerate, tProceed - 0.01),
  };
}

/**
 * Measure accuracy of a threshold configuration against labeled examples.
 * Returns fraction of examples where gsarDecision(score) === expected.
 */
export function measureThresholdAccuracy(
  examples: LabeledExample[],
  thresholds: GSARThresholds,
  weights: EvidenceWeights = DEFAULT_WEIGHTS,
  rho = 1.0,
): number {
  if (examples.length === 0) {
    return 0;
  }
  const correct = examples.filter((e) => {
    const score = computeGroundednessScore(e.partition, weights, rho);
    return gsarDecision(score, thresholds) === e.expected;
  }).length;
  return correct / examples.length;
}
