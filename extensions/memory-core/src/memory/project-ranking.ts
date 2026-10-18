import { INVALID_PROJECT_ANNOTATION_KEY } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

type ProjectRankable = {
  score: number;
  importance?: number;
  projectKey?: string;
};

export function prepareActiveProjectKeys(
  activeProjectKeys: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  return activeProjectKeys?.length ? new Set(activeProjectKeys) : undefined;
}

export function projectScoreMultiplier(
  projectKey: string | null | undefined,
  activeProjectKeys: ReadonlySet<string> | undefined,
): number {
  if (!projectKey || !activeProjectKeys || activeProjectKeys.size === 0) {
    return 1;
  }
  const stored = projectKey
    .split(";")
    .map((key) => key.trim())
    .filter(Boolean);
  return stored.every((key) => activeProjectKeys.has(key)) ? 1.15 : 0.9;
}

export function applyRetrievalRanking<T extends ProjectRankable>(
  results: readonly T[],
  activeProjectKeys?: ReadonlySet<string>,
): T[] {
  const weighted = results.map((entry) => {
    const importance = entry.importance;
    const multiplier =
      importance === null || importance === undefined
        ? 1
        : 0.75 + Math.max(1, Math.min(10, Math.floor(importance))) * 0.05;
    return { ...entry, score: entry.score * multiplier };
  });
  const eligible = weighted.filter(
    (entry) =>
      !entry.projectKey
        ?.split(";")
        .map((key) => key.trim())
        .includes(INVALID_PROJECT_ANNOTATION_KEY),
  );
  if (!activeProjectKeys || activeProjectKeys.size === 0) {
    return eligible;
  }
  // Retrieval owners sort after score adjustment, preserving their exact-match tiers.
  return eligible.map((entry) =>
    Object.assign({}, entry, {
      score: entry.score * projectScoreMultiplier(entry.projectKey, activeProjectKeys),
    }),
  );
}
