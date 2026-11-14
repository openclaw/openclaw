import type { PromotionCandidate } from "./short-term-promotion.js";

export function consolidationCandidate(
  originClass: "owner" | "agent" | "untrusted" | "system",
  overrides: Partial<PromotionCandidate> = {},
): PromotionCandidate {
  return {
    key: `memory:memory/2026-07-01.md:1:1:${originClass}`,
    path: "memory/2026-07-01.md",
    startLine: 1,
    endLine: 1,
    source: "memory",
    snippet: "User prefers green tea.",
    recallCount: 3,
    signalCount: 3,
    avgScore: 0.9,
    maxScore: 0.9,
    uniqueQueries: 2,
    firstRecalledAt: "2026-07-01T10:00:00.000Z",
    lastRecalledAt: "2026-07-01T10:00:00.000Z",
    ageDays: 0,
    score: 0.9,
    recallDays: ["2026-07-01", "2026-07-02"],
    conceptTags: ["preference"],
    components: {
      frequency: 1,
      relevance: 0.9,
      diversity: 0.5,
      recency: 1,
      consolidation: 0.5,
      conceptual: 0.2,
    },
    provenance: {
      originClass,
      sessionKind: "interactive",
      observedAt: Date.parse("2026-07-01T10:00:00.000Z"),
    },
    ...overrides,
  };
}
