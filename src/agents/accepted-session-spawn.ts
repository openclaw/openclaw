import { normalizeOptionalString } from "../shared/string-coerce.js";

export type AcceptedSessionSpawn = {
  runId: string;
  childSessionKey: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function normalizeAcceptedSessionSpawnResult(result: unknown): AcceptedSessionSpawn | null {
  const details = asRecord(asRecord(result)?.details);
  if (!details || details.status !== "accepted") {
    return null;
  }
  const runId = normalizeOptionalString(details.runId);
  const childSessionKey = normalizeOptionalString(details.childSessionKey);
  if (!runId || !childSessionKey) {
    return null;
  }
  return { runId, childSessionKey };
}

export function hasAcceptedSessionSpawn(
  acceptedSessionSpawns?: readonly AcceptedSessionSpawn[],
): boolean {
  return (acceptedSessionSpawns ?? []).some((spawn) => {
    return Boolean(
      normalizeOptionalString(spawn.runId) && normalizeOptionalString(spawn.childSessionKey),
    );
  });
}
