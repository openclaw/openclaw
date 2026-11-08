/**
 * Stable announce identifiers for child-run completion messages.
 * Versioned keys let future formats coexist with persisted v1 delivery records.
 */
import { createHash } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

// Announce keys are also run IDs, bounded by execution-identity admission.
const MAX_ANNOUNCE_KEY_LENGTH = 256;

export function buildAnnounceIdFromChildRun(params: {
  childSessionKey: string;
  childRunId: string;
}): string {
  return `v1:${params.childSessionKey}:${params.childRunId}`;
}

export function buildAnnounceIdempotencyKey(announceId: string): string {
  const key = `announce:${announceId}`;
  if (key.length <= MAX_ANNOUNCE_KEY_LENGTH) {
    return key;
  }
  // Retain terminal continuation markers, especially the descendant-wake guard.
  const suffix = /(?::yield-\d+)?(?::pause)?(?::retry-\d+)?(?::wake)?$/u.exec(key)?.[0] ?? "";
  const digest = createHash("sha256").update(key).digest("hex");
  const prefix = truncateUtf16Safe(
    key,
    MAX_ANNOUNCE_KEY_LENGTH - digest.length - 1 - suffix.length,
  );
  return `${prefix}:${digest}${suffix}`;
}
