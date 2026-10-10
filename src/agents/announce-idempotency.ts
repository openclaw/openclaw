/**
 * Stable announce identifiers for child-run completion messages.
 * Versioned keys let future formats coexist with persisted v1 delivery records.
 */
export function buildAnnounceIdFromChildRun(params: {
  childSessionKey: string;
  childRunId: string;
}): string {
  return `v1:${params.childSessionKey}:${params.childRunId}`;
}

export function buildAnnounceIdempotencyKey(announceId: string): string {
  return `announce:${announceId}`;
}
