/**
 * Detect when a final reply payload's text was already delivered to the user
 * via the partial-preview stream (editMessageText), so the channel dispatcher
 * can skip the duplicate send while still finalizing the lane.
 *
 * Equivalent semantics to the previous core-layer suppressPreviewStreamedPayloads
 * (PR #82625 / commit bd51d8f2dd), but kept here so the suppression and the
 * lane-finalized signal stay co-located: the dispatcher updates
 * lane.finalized = true at the same place it decides to skip the send, which
 * prevents the unfinalized-preview cleanup from deleting the preview message
 * when all finals are suppressed (the regression reported in openclaw#80520).
 */

export function normalizePreviewDedupeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function buildPreviewDedupeTextSet(value: string | undefined): Set<string> {
  const set = new Set<string>();
  const whole = normalizePreviewDedupeText(value);
  if (whole) {
    set.add(whole);
  }
  for (const block of (value ?? "").split(/\n{2,}/u)) {
    const normalized = normalizePreviewDedupeText(block);
    if (normalized) {
      set.add(normalized);
    }
  }
  return set;
}

export function isPreviewStreamedText(
  candidate: string | undefined,
  previewDedupeText: Set<string>,
): boolean {
  if (previewDedupeText.size === 0) {
    return false;
  }
  const normalized = normalizePreviewDedupeText(candidate);
  if (!normalized) {
    return false;
  }
  return previewDedupeText.has(normalized);
}
