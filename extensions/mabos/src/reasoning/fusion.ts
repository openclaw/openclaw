/**
 * Multi-method fusion — combines results from multiple reasoning methods.
 */

import type { ReasoningResult, FusionResult } from "./types.js";

/**
 * Format multiple reasoning results into a synthesis prompt for the LLM.
 */
export function fuseResults(results: ReasoningResult[]): FusionResult {
  const agreement = computeAgreementScore(results);
  const disagreements = detectDisagreement(results);

  const synthesized =
    results.length === 1
      ? results[0].conclusion
      : `Synthesized from ${results.length} methods (${results.map((r) => r.method).join(", ")}): ` +
        results.map((r) => `[${r.method}] ${r.conclusion}`).join(" | ");

  return {
    methods_used: results.map((r) => r.method),
    individual_results: results,
    synthesized_conclusion: synthesized,
    agreement_score: agreement,
    disagreements,
    confidence:
      results.length > 0 ? results.reduce((sum, r) => sum + r.confidence, 0) / results.length : 0,
  };
}

/**
 * Detect disagreements between reasoning results.
 * Uses simple heuristic: conclusions that differ significantly.
 */
export function detectDisagreement(results: ReasoningResult[]): string[] {
  const disagreements: string[] = [];
  if (results.length < 2) return disagreements;

  // Compare confidence levels — large spreads indicate disagreement
  const confidences = results.map((r) => r.confidence);
  const maxConf = Math.max(...confidences);
  const minConf = Math.min(...confidences);

  if (maxConf - minConf > 0.4) {
    const high = results.find((r) => r.confidence === maxConf)!;
    const low = results.find((r) => r.confidence === minConf)!;
    disagreements.push(
      `Confidence spread: ${high.method} (${maxConf.toFixed(2)}) vs ${low.method} (${minConf.toFixed(2)})`,
    );
  }

  // Check for explicit contradiction keywords
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i].conclusion.toLowerCase();
      const b = results[j].conclusion.toLowerCase();
      // Simple heuristic: one says "should" and other says "should not"
      if (
        (a.includes("should not") && b.includes("should") && !b.includes("should not")) ||
        (b.includes("should not") && a.includes("should") && !a.includes("should not"))
      ) {
        disagreements.push(
          `Directional conflict between ${results[i].method} and ${results[j].method}`,
        );
      }
    }
  }

  return disagreements;
}

/**
 * Compute agreement score based on confidence alignment.
 * Returns 0-1: 1 means perfect agreement.
 */
export function computeAgreementScore(results: ReasoningResult[]): number {
  if (results.length < 2) return 1;

  const confidences = results.map((r) => r.confidence);
  const mean = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  const variance = confidences.reduce((sum, c) => sum + (c - mean) ** 2, 0) / confidences.length;

  // Low variance = high agreement
  return Math.max(0, 1 - Math.sqrt(variance) * 2);
}

/**
 * Format fusion result as a markdown text block for LLM synthesis prompt.
 */
export function formatFusionPrompt(fusion: FusionResult): string {
  const parts = [
    `## Multi-Method Reasoning Fusion`,
    ``,
    `**Methods used:** ${fusion.methods_used.join(", ")}`,
    `**Agreement score:** ${(fusion.agreement_score * 100).toFixed(0)}%`,
    ``,
  ];

  for (const result of fusion.individual_results) {
    parts.push(
      `### ${result.method} (${result.category}) — confidence: ${(result.confidence * 100).toFixed(0)}%`,
    );
    parts.push(result.conclusion);
    parts.push(``);
  }

  if (fusion.disagreements.length > 0) {
    parts.push(`### Disagreements`);
    for (const d of fusion.disagreements) {
      parts.push(`- ${d}`);
    }
    parts.push(``);
  }

  parts.push(`Synthesize these perspectives into a unified conclusion. Address any disagreements.`);
  return parts.join("\n");
}
