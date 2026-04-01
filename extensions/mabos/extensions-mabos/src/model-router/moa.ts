export interface MoAResult {
  finalAnswer: string;
  referenceResponses: Array<{ model: string; response: string }>;
  agreement: number;
  totalCostUsd: number;
}

export function buildReferencePrompt(problem: string): string {
  return `You are one of several expert models providing independent analysis.

Problem: ${problem}

Provide your complete reasoning and answer. Be thorough and show your work.
Focus on accuracy and detail.`;
}

export function buildAggregatorPrompt(
  problem: string,
  references: Array<{ model: string; response: string }>,
): string {
  const refSection = references
    .map((r, i) => `### Model ${r.model} (Response ${i + 1})\n${r.response}`)
    .join("\n\n");

  return `You are the aggregator in a Mixture-of-Agents ensemble.

Original problem: ${problem}

The following expert models have provided independent responses:

${refSection}

Synthesize these responses into a single, high-quality answer:
1. Identify points of agreement (these are likely correct)
2. Flag points of disagreement and resolve them with reasoning
3. Provide a final, comprehensive answer that combines the best insights`;
}

export function calculateAgreementScore(responses: string[]): number {
  if (responses.length < 2) return 1;

  const tokenSets = responses.map(
    (r) =>
      new Set(
        r
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3),
      ),
  );

  let totalOverlap = 0;
  let comparisons = 0;

  for (let i = 0; i < tokenSets.length; i++) {
    for (let j = i + 1; j < tokenSets.length; j++) {
      const intersection = new Set([...tokenSets[i]].filter((w) => tokenSets[j].has(w)));
      const union = new Set([...tokenSets[i], ...tokenSets[j]]);
      totalOverlap += union.size > 0 ? intersection.size / union.size : 0;
      comparisons++;
    }
  }

  return comparisons > 0 ? totalOverlap / comparisons : 0;
}
