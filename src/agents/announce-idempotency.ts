/**
 * Stable announce identifiers for child-run completion messages.
 * Versioned keys let future formats coexist with persisted v1 delivery records.
 */
type AnnounceIdFromChildRunParams = {
  childSessionKey: string;
  childRunId: string;
};

/** Build the persisted announce id for a child session/run pair. */
export function buildAnnounceIdFromChildRun(params: AnnounceIdFromChildRunParams): string {
  return `v1:${params.childSessionKey}:${params.childRunId}`;
}

const ANNOUNCE_IDEMPOTENCY_KEY_PREFIX = "announce:";

/** Build the idempotency key used by announce delivery storage. */
export function buildAnnounceIdempotencyKey(announceId: string): string {
  return `${ANNOUNCE_IDEMPOTENCY_KEY_PREFIX}${announceId}`;
}

/**
 * True when a gateway run id belongs to an announce/completion delivery turn.
 * The `agent` method reuses the idempotency key as the run id
 * (`server-methods/agent.ts`: `runId = idem`), so this prefix check is the only
 * announce-vs-human-turn signal that survives a gateway restart into persisted
 * `restartRecoveryRuns`.
 */
export function isAnnounceRunId(runId: string | null | undefined): boolean {
  return typeof runId === "string" && runId.startsWith(ANNOUNCE_IDEMPOTENCY_KEY_PREFIX);
}
