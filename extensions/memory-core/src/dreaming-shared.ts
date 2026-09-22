// Memory Core plugin module implements dreaming shared behavior.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

export function formatRecallRepairDetails(repair: {
  removedInvalidEntries: number;
  removedDanglingEntries?: number;
  removedOverflowEntries?: number;
}): string {
  const removedOverflowEntries = repair.removedOverflowEntries ?? 0;
  return [
    repair.removedInvalidEntries > 0 ? `-${repair.removedInvalidEntries} invalid` : null,
    (repair.removedDanglingEntries ?? 0) > 0 ? `-${repair.removedDanglingEntries} dangling` : null,
    removedOverflowEntries > 0 ? `-${removedOverflowEntries} overflow` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

export function includesSystemEventToken(cleanedBody: string, eventText: string): boolean {
  const normalizedBody = normalizeOptionalString(cleanedBody);
  const normalizedEventText = normalizeOptionalString(eventText);
  if (!normalizedBody || !normalizedEventText) {
    return false;
  }
  if (normalizedBody === normalizedEventText) {
    return true;
  }
  return normalizedBody.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (trimmed === normalizedEventText) {
      return true;
    }
    // Isolated cron turns wrap the payload with a `[cron:<id>] ...` prefix; strip
    // that one known wrapper before matching so the dream sentinel still triggers
    // without falling back to a broad substring match (which would let any user
    // message embedding the token surface as a dream cron firing).
    return trimmed.replace(/^\[cron:[^\]]+\]\s*/, "") === normalizedEventText;
  });
}
