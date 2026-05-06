export type CuratorConfig = {
  enabled: boolean;
  interval_hours: number;
  min_idle_hours: number;
  stale_after_days: number;
  archive_after_days: number;
  backup: {
    enabled: boolean;
    keep: number;
  };
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(Math.trunc(value), min), max)
    : fallback;
}

/**
 * Resolve and validate curator configuration from raw plugin config.
 * Mirrors skill-workshop's config resolution pattern.
 */
export function resolveConfig(raw: unknown): CuratorConfig {
  const cfg = asRecord(raw);
  const backup = asRecord(cfg.backup);

  return {
    enabled: readBoolean(cfg.enabled, true),
    interval_hours: readInteger(cfg.interval_hours, 168, 1, 8760),
    min_idle_hours: readInteger(cfg.min_idle_hours, 2, 0, 168),
    stale_after_days: readInteger(cfg.stale_after_days, 30, 1, 3650),
    archive_after_days: readInteger(cfg.archive_after_days, 90, 1, 3650),
    backup: {
      enabled: readBoolean(backup.enabled, true),
      keep: readInteger(backup.keep, 5, 1, 100),
    },
  };
}
