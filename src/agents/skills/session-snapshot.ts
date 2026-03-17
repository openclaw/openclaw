import type { SkillSnapshot } from "./types.js";

function normalizeSnapshot(snapshot: SkillSnapshot | undefined) {
  if (!snapshot) {
    return undefined;
  }
  return {
    prompt: snapshot.prompt,
    skills: snapshot.skills,
    skillFilter: snapshot.skillFilter,
  };
}

function areSkillSnapshotsEquivalent(
  left: SkillSnapshot | undefined,
  right: SkillSnapshot | undefined,
): boolean {
  return JSON.stringify(normalizeSnapshot(left)) === JSON.stringify(normalizeSnapshot(right));
}

export function resolveSessionSkillsSnapshot(params: {
  currentSnapshot?: SkillSnapshot;
  isNewSession: boolean;
  snapshotVersion: number;
  buildSnapshot: () => SkillSnapshot;
}): {
  skillsSnapshot?: SkillSnapshot;
  shouldPersist: boolean;
} {
  if (params.isNewSession || !params.currentSnapshot) {
    return {
      skillsSnapshot: params.buildSnapshot(),
      shouldPersist: true,
    };
  }

  const currentVersion = params.currentSnapshot.version ?? 0;
  if (currentVersion < params.snapshotVersion) {
    return {
      skillsSnapshot: params.buildSnapshot(),
      shouldPersist: true,
    };
  }

  if (params.snapshotVersion === 0) {
    const rebuiltSnapshot = params.buildSnapshot();
    if (!areSkillSnapshotsEquivalent(params.currentSnapshot, rebuiltSnapshot)) {
      return {
        skillsSnapshot: rebuiltSnapshot,
        shouldPersist: true,
      };
    }
  }

  return {
    skillsSnapshot: params.currentSnapshot,
    shouldPersist: false,
  };
}
