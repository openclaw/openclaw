import { SKILL_SNAPSHOT_SCHEMA_VERSION, type SkillSnapshot } from "./types.js";

type SnapshotWithRuntimeSkills = {
  resolvedSkills?: unknown;
};

/**
 * Force-refresh persisted snapshots whose `schemaVersion` is missing or
 * predates the current `SkillSnapshot` shape. The lane-split fields
 * (`trustedDeveloperPrompt`, `untrustedReferencePrompt`) were added at
 * schema v2 (2026-05-25); v1 snapshots (no `schemaVersion`) lack those
 * fields entirely, so the Codex call site would silently drop both lanes
 * on hydrate-only reuse. Returning `true` triggers a rebuild via
 * `buildWorkspaceSkillSnapshot` so the new fields are populated before
 * the snapshot is read.
 */
export function isSkillsSnapshotSchemaOutdated(
  snapshot: Pick<SkillSnapshot, "schemaVersion"> | undefined,
): boolean {
  if (!snapshot) {
    return false;
  }
  const persisted = snapshot.schemaVersion ?? 0;
  return persisted < SKILL_SNAPSHOT_SCHEMA_VERSION;
}

type SnapshotRebuild<T extends SnapshotWithRuntimeSkills> = {
  resolvedSkills?: T["resolvedSkills"];
};

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
  return { ...snapshot, resolvedSkills: rebuild().resolvedSkills };
}

export async function hydrateResolvedSkillsAsync<T extends SnapshotWithRuntimeSkills>(
  snapshot: T,
  rebuild: () => Promise<SnapshotRebuild<T>>,
): Promise<T> {
  if (snapshot.resolvedSkills !== undefined) {
    return snapshot;
  }
  return { ...snapshot, resolvedSkills: (await rebuild()).resolvedSkills };
}
