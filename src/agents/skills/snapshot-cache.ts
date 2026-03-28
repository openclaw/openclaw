import type { OpenClawConfig } from "../../config/config.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { matchesSkillFilter } from "./filter.js";
import type { SkillSnapshot } from "./types.js";

function normalizeSnapshotVersion(version?: number): number {
  return version ?? 0;
}

export function resolveSkillsSnapshotConfigKey(config?: OpenClawConfig): string | undefined {
  const normalizedPriority = normalizeStringEntries(config?.skills?.priority);
  if (normalizedPriority.length === 0) {
    return undefined;
  }
  return JSON.stringify({ priority: normalizedPriority });
}

export function canReuseSkillSnapshot(params: {
  snapshot?: Pick<SkillSnapshot, "configKey" | "skillFilter" | "version">;
  snapshotVersion: number;
  config?: OpenClawConfig;
  skillFilter?: ReadonlyArray<unknown>;
}): boolean {
  const snapshot = params.snapshot;
  if (!snapshot) {
    return false;
  }
  if (
    normalizeSnapshotVersion(snapshot.version) !== normalizeSnapshotVersion(params.snapshotVersion)
  ) {
    return false;
  }
  if (!matchesSkillFilter(snapshot.skillFilter, params.skillFilter)) {
    return false;
  }
  return snapshot.configKey === resolveSkillsSnapshotConfigKey(params.config);
}
