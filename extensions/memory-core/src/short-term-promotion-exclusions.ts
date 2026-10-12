import type {
  PromotionExclusion,
  PromotionExclusionReason,
  PromotionRejectionCategory,
} from "./short-term-promotion-types.js";

const MAX_SAMPLE_KEYS = 3;

// Ranking gate order; each excluded entry is counted once, under the first gate that dropped it.
const PROMOTION_EXCLUSION_ORDER: readonly PromotionExclusionReason[] = [
  "path",
  "origin",
  "contamination",
  "already promoted",
  "no signal",
  "signal threshold",
  "query threshold",
  "age threshold",
  "score threshold",
];

export type PromotionExclusionCount = {
  reason: PromotionExclusionReason;
  count: number;
  sampleKeys: string[];
};

/** Counts exclusions per reason, in gate order, omitting reasons with no entries. */
export function countPromotionExclusions(
  exclusions: readonly PromotionExclusion[],
): PromotionExclusionCount[] {
  return PROMOTION_EXCLUSION_ORDER.flatMap((reason) => {
    const matching = exclusions.filter((exclusion) => exclusion.reason === reason);
    return matching.length > 0
      ? [
          {
            reason,
            count: matching.length,
            sampleKeys: matching.slice(0, MAX_SAMPLE_KEYS).map((exclusion) => exclusion.key),
          },
        ]
      : [];
  });
}

/** Counts apply rejections per category, in first-seen order. */
export function countPromotionRejections(
  rejections: ReadonlyArray<{ category: PromotionRejectionCategory }>,
): Array<{ category: PromotionRejectionCategory; count: number }> {
  const counts = new Map<PromotionRejectionCategory, number>();
  for (const { category } of rejections) {
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts].map(([category, count]) => ({ category, count }));
}

export function formatLabelCounts(counts: ReadonlyArray<readonly [string, number]>): string {
  return counts.map(([label, count]) => `${label} ${count}`).join(", ");
}

/**
 * Reasons a run promoted nothing, ranking exclusions first. Apply only sees ranking
 * survivors, so summing per label still counts each entry once.
 */
export function formatZeroPromotionReasons(
  exclusions: readonly PromotionExclusion[],
  rejections: ReadonlyArray<{ category: PromotionRejectionCategory }>,
): string {
  const counts = new Map<string, number>();
  for (const [label, labelCount] of [
    ...countPromotionExclusions(exclusions).map(({ reason, count }) => [reason, count] as const),
    ...countPromotionRejections(rejections).map(
      ({ category, count }) => [category, count] as const,
    ),
  ]) {
    counts.set(label, (counts.get(label) ?? 0) + labelCount);
  }
  return formatLabelCounts([...counts]);
}

const STRUCTURAL_AND_STATE_HINTS: Record<
  Exclude<PromotionExclusionReason, "query threshold">,
  string
> = {
  path: "not a short-term memory path; these never promote.",
  origin:
    "from untrusted sources (e.g. daily notes written during turns that read network content: browser, web fetch, MCP and other network tools); these never promote.",
  contamination: "looks like a raw transcript turn; these only promote from session corpus files.",
  "already promoted": "already in MEMORY.md; pass --include-promoted to list them.",
  "no signal": "no recall, daily or grounded signal recorded yet.",
  "signal threshold": "fewer signals than --min-recall-count.",
  "age threshold":
    "last recalled more than dreaming.maxAgeDays days ago (a config setting; there is no flag).",
  "score threshold": "weighted score below --min-score.",
};

/**
 * Explains a ranking exclusion and the next step. Structural gates (path, origin,
 * contamination) are safeguards, so their hints never offer a way around them.
 */
export function describePromotionExclusion(
  reason: PromotionExclusionReason,
  thresholds: { minUniqueQueries: number },
): string {
  return reason === "query threshold"
    ? `memory_search returned these for fewer than ${thresholds.minUniqueQueries} distinct queries. Since 2026.9.4, daily-note and session ingestion don't count toward this.`
    : STRUCTURAL_AND_STATE_HINTS[reason];
}
