import type { DoltQueryAvailability } from "../read-only-dolt-store.js";

/**
 * Build a consistent response when Dolt context data is not available yet.
 */
export function buildNoContextDataMessage(availability: DoltQueryAvailability): string {
  if (availability.reason === "open_failed") {
    const detail = availability.detail?.trim();
    return detail
      ? `Dolt context data is not available yet. Could not open read-only DB at ${availability.dbPath}: ${detail}`
      : `Dolt context data is not available yet. Could not open read-only DB at ${availability.dbPath}.`;
  }

  return `No context data yet. Dolt DB not found at ${availability.dbPath}. Once context compaction runs, this tool will return results.`;
}

/**
 * Build a standard scaffold response for tools whose full logic lands in follow-up pebbles.
 */
export function buildScaffoldMessage(toolName: string): string {
  return `${toolName} scaffold is active. Full execute behavior is implemented in follow-up pebbles.`;
}
