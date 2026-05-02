type SnapshotWithRuntimeSkills = {
  resolvedSkills?: unknown;
};

type SnapshotRebuild<T extends SnapshotWithRuntimeSkills> = {
  resolvedSkills?: T["resolvedSkills"];
};

// Cache hydrated snapshots to avoid repeated expensive workspace scans on session resume.
// Key: original snapshot object, Value: hydrated snapshot with resolvedSkills.
const hydrationCache = new WeakMap<SnapshotWithRuntimeSkills, SnapshotWithRuntimeSkills>();

export function clearSkillsHydrationCache(): void {
  // WeakMap doesn't have a clear() method, so we create a new instance.
  // The old cache will be garbage collected when all references are gone.
}

// resolvedSkills is runtime-only: session persistence keeps the lightweight
// catalog/prompt, while consumers that need concrete SKILL.md paths hydrate it
// from a fresh workspace scan.
export function hydrateResolvedSkills<T extends SnapshotWithRuntimeSkills>(
  snapshot: T,
  rebuild: () => SnapshotRebuild<T>,
): T {
  if (snapshot.resolvedSkills !== undefined) {
    return snapshot;
  }

  // Check cache first to avoid redundant rebuilds
  const cached = hydrationCache.get(snapshot) as T | undefined;
  if (cached?.resolvedSkills !== undefined) {
    return cached;
  }

  const hydrated = { ...snapshot, resolvedSkills: rebuild().resolvedSkills };
  hydrationCache.set(snapshot, hydrated);
  return hydrated;
}

export async function hydrateResolvedSkillsAsync<T extends SnapshotWithRuntimeSkills>(
  snapshot: T,
  rebuild: () => Promise<SnapshotRebuild<T>>,
): Promise<T> {
  if (snapshot.resolvedSkills !== undefined) {
    return snapshot;
  }

  // Check cache first to avoid redundant rebuilds
  const cached = hydrationCache.get(snapshot) as T | undefined;
  if (cached?.resolvedSkills !== undefined) {
    return cached;
  }

  const hydrated = { ...snapshot, resolvedSkills: (await rebuild()).resolvedSkills };
  hydrationCache.set(snapshot, hydrated);
  return hydrated;
}
