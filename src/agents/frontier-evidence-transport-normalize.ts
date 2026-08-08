import type { Model } from "@openclaw/llm-core";

export function normalizedFrontierEvidenceJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => (entry === undefined ? undefined : entry));
}

export function canonicalFrontierEvidenceJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) {
      return entry.map(normalize);
    }
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .filter(([, child]) => child !== undefined)
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

export function expectedFrontierEvidenceContextManagement(model: Model): unknown {
  const contextWindow =
    typeof model.contextWindow === "number" &&
    Number.isFinite(model.contextWindow) &&
    model.contextWindow > 0
      ? Math.floor(model.contextWindow)
      : undefined;
  return [
    {
      type: "compaction",
      compact_threshold: contextWindow ? Math.max(1_000, Math.floor(contextWindow * 0.7)) : 80_000,
    },
  ];
}
