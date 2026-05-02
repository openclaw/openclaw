import type { ResolvedStructuredMemoryConfig } from "./config";
import type { MemoryRecord, RelevanceResult } from "./types";

const MS_PER_DAY = 86400000;

export function isProtected(record: { critical: 0 | 1; activate_at: string | null }): boolean {
  const now = Date.now();
  if (record.critical === 1) return true;
  if (record.activate_at && new Date(record.activate_at).getTime() > now) return true;
  return false;
}

export function computeRelevance(
  record: MemoryRecord,
  config: Pick<ResolvedStructuredMemoryConfig, "decay">,
): RelevanceResult {
  const now = Date.now();

  // RFC §4.3: expire_at到期必须自动归档
  if (record.expire_at) {
    const expireAt = new Date(record.expire_at).getTime();
    if (now >= expireAt) {
      return {
        relevance: 0,
        decay_factor: 0,
        access_boost: 1,
        maintenance_score: 0,
        should_archive: true,
        archive_reason: `expired at ${record.expire_at}`,
      };
    }
  }

  // RFC §4.3: critical immunity — critical records never auto-archive
  if (isProtected(record)) {
    const updatedAt = new Date(record.updated_at).getTime();
    const daysSinceUpdate = Math.max(0, (now - updatedAt) / MS_PER_DAY);
    const decayFactor = Math.exp(
      -0.693 * Math.pow(daysSinceUpdate / config.decay.halfLifeDays, 1.5),
    );
    const effectiveImportance = record.importance * decayFactor;
    const importanceNormalized = Math.max(0, Math.min(1, effectiveImportance / 10));
    const daysSinceAccess = record.last_accessed_at
      ? Math.max(0, (now - new Date(record.last_accessed_at).getTime()) / MS_PER_DAY)
      : Math.max(0, (now - new Date(record.created_at).getTime()) / MS_PER_DAY);
    const maintenanceScore =
      ((record.confidence * 0.3 + importanceNormalized * 0.7) * record.salience) /
      (1 + daysSinceAccess);

    if (record.activate_at && new Date(record.activate_at).getTime() > now) {
      return {
        relevance: maintenanceScore * 0.3,
        decay_factor: decayFactor,
        access_boost: 1.0,
        maintenance_score: maintenanceScore,
        should_archive: false,
        archive_reason: `protected (activates_at ${record.activate_at})`,
      };
    }

    return {
      relevance: maintenanceScore,
      decay_factor: decayFactor,
      access_boost: 1.0,
      maintenance_score: maintenanceScore,
      should_archive: false,
    };
  }

  const updatedAt = new Date(record.updated_at).getTime();
  const daysSinceUpdate = Math.max(0, (now - updatedAt) / MS_PER_DAY);
  const decayFactor = Math.exp(-0.693 * Math.pow(daysSinceUpdate / config.decay.halfLifeDays, 1.5));

  let accessBoost = 1.0;
  if (record.last_accessed_at) {
    const lastAccess = new Date(record.last_accessed_at).getTime();
    const daysSinceLastAccess = Math.max(0, (now - lastAccess) / MS_PER_DAY);
    if (daysSinceLastAccess <= 3) {
      accessBoost = 1.0;
    } else if (daysSinceLastAccess <= 7) {
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
    should_archive: shouldArchive,
    ...(shouldArchive
      ? {
          archive_reason: `maintenance_score ${maintenanceScore.toFixed(4)} below threshold ${config.decay.minMaintenanceScore}`,
        }
      : {}),
  };
}
