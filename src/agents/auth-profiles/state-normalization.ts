import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { coerceProfileUsageStats } from "./profile-usage-stats.js";
import type { AuthProfileState } from "./types.js";

function normalizeAuthProfileEntries<T>(
  raw: unknown,
  normalizeKey: (value: string) => string | undefined,
  normalizeValue: (value: unknown) => T | undefined,
): Record<string, T> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const normalized: Record<string, T> = {};
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = normalizeKey(rawKey);
    const value = normalizeValue(rawValue);
    if (!key || value === undefined) {
      continue;
    }
    normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** Coerces persisted auth profile runtime state into the current shape. */
export function coerceAuthProfileState(raw: unknown): AuthProfileState {
  if (!isRecord(raw)) {
    return {};
  }
  return {
    order: normalizeAuthProfileEntries(raw.order, normalizeProviderId, (value) => {
      const ids = Array.isArray(value) ? normalizeTrimmedStringList(value) : [];
      return ids.length > 0 ? ids : undefined;
    }),
    lastGood: normalizeAuthProfileEntries(
      raw.lastGood,
      normalizeProviderId,
      normalizeOptionalString,
    ),
    usageStats: normalizeAuthProfileEntries(
      raw.usageStats,
      normalizeOptionalString,
      coerceProfileUsageStats,
    ),
  };
}
