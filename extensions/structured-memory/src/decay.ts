import type { ResolvedStructuredMemoryConfig } from "./config";
import type { MemoryRecord, RelevanceResult } from "./types";

const MS_PER_DAY = 86400000;

export function computeRelevance(
  record: MemoryRecord,
  config: Pick<ResolvedStructuredMemoryConfig, "decay">,
): RelevanceResult {
  const now = Date.now();
  const updatedAt = new Date(record.updated_at).getTime();

  const daysSinceUpdate = Math.max(0, (now - updatedAt) / MS_PER_DAY);

  const decayFactor = Math.exp(-0.693 * Math.pow(daysSinceUpdate / config.decay.halfLifeDays, 1.5));

  let accessBoost = 1.0;
  if (record.last_accessed_at) {
    const lastAccess = new Date(record.last_accessed_at).getTime();
    const daysSinceAccess = Math.max(0, (now - lastAccess) / MS_PER_DAY);
    if (daysSinceAccess <= 3) {
      accessBoost = 1.0;
    } else if (daysSinceAccess <= 7) {
      accessBoost = 0.8;
    } else {
      accessBoost = 0.5;
    }
  }

  const effectiveImportance = record.importance * decayFactor * accessBoost;
  const importanceNormalized = Math.max(0, Math.min(1, effectiveImportance / 10));

  const daysSinceAccess = record.last_accessed_at
    ? Math.max(0, (now - new Date(record.last_accessed_at).getTime()) / MS_PER_DAY)
    : Math.max(0, (now - new Date(record.created_at).getTime()) / MS_PER_DAY);

  const maintenanceScore =
    ((record.confidence * 0.3 + importanceNormalized * 0.7) * record.salience) /
    (1 + daysSinceAccess);

  const relevance = maintenanceScore;
  const shouldArchive = relevance < config.decay.minMaintenanceScore;

  return {
    relevance,
    decay_factor: decayFactor,
    access_boost: accessBoost,
    maintenance_score: maintenanceScore,
    should_archive,
    ...(shouldArchive
      ? {
          archive_reason: `maintenance_score ${maintenanceScore.toFixed(4)} below threshold ${config.decay.minMaintenanceScore}`,
        }
      : {}),
  };
}
