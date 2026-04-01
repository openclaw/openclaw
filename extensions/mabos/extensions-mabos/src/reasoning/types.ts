/**
 * Shared types for the MABOS reasoning engine.
 */

/** Result from a single reasoning method invocation. */
export interface ReasoningResult {
  method: string;
  category: string;
  conclusion: string;
  confidence: number; // 0-1
  reasoning_trace: string;
  metadata?: Record<string, unknown>;
}

/** Six-dimensional problem classification used by meta-reasoning. */
export interface ProblemClassification {
  uncertainty: "low" | "medium" | "high";
  complexity: "simple" | "moderate" | "complex";
  domain: "formal" | "empirical" | "social" | "mixed";
  time_pressure: "none" | "moderate" | "urgent";
  data_availability: "rich" | "moderate" | "sparse";
  stakes: "low" | "medium" | "high";
}

/** Recommendation from meta-reasoning for which method(s) to use. */
export interface MethodRecommendation {
  method: string;
  score: number; // 0-1 suitability
  rationale: string;
}

/** Result of fusing multiple reasoning method outputs. */
export interface FusionResult {
  methods_used: string[];
  individual_results: ReasoningResult[];
  synthesized_conclusion: string;
  agreement_score: number; // 0-1
  disagreements: string[];
  confidence: number;
}

/** Catalog entry for a reasoning method. */
export interface ReasoningMethodEntry {
  category: string;
  description: string;
  prompt: string;
  applicable_when: string;
  algorithmic: boolean;
  dedicated_tool?: string;
}
