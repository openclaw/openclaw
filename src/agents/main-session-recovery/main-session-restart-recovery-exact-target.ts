import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  hasMainSessionRecoveryClaim,
  isMainRestartRecoveryCandidate,
} from "../../config/sessions/restart-recovery-state.js";
import { loadExactSessionEntry } from "../../config/sessions/session-accessor.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { ExpectedRestartRecoveryTarget } from "./main-session-restart-recovery-shared.js";

type ExpectedRecoveryRead = {
  expected: ExpectedRestartRecoveryTarget;
  storePath: string;
};

function matchesExpectedRecoveryTarget(
  entry:
    | Pick<
        SessionEntry,
        | "sessionId"
        | "abortedLastRun"
        | "restartRecoveryDeliveryRunId"
        | "restartRecoveryDeliverySourceRunId"
        | "spawnDepth"
        | "subagentRole"
      >
    | undefined,
  expected: ExpectedRestartRecoveryTarget,
  hasClaim: boolean,
): boolean {
  return (
    entry?.sessionId === expected.sessionId &&
    hasClaim &&
    entry.abortedLastRun === true &&
    (expected.claim
      ? normalizeOptionalString(entry.restartRecoveryDeliveryRunId) === expected.claim.runId &&
        normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) ===
          expected.claim.sourceRunId
      : isMainRestartRecoveryCandidate(entry, expected.sessionKey))
  );
}

/** Retain the memory owner and current recovery predicates across admission waits. */
export function captureExpectedRestartRecoveryCurrent(params: ExpectedRecoveryRead): () => boolean {
  const expected = {
    ...params.expected,
    claim: params.expected.claim && { ...params.expected.claim },
  };
  const target = { ...expected, storePath: params.storePath };
  const source = captureSessionEntryMetadataRead(target, () => {});
  if (source) {
    return () => {
      const current = source.readCurrent();
      return matchesExpectedRecoveryTarget(current, expected, hasMainSessionRecoveryClaim(current));
    };
  }
  return () => {
    const exact = loadExactSessionEntry({ ...target, readConsistency: "latest" });
    const current = exact?.sessionKey === target.sessionKey ? exact.entry : undefined;
    return matchesExpectedRecoveryTarget(current, expected, hasMainSessionRecoveryClaim(current));
  };
}

export async function loadExpectedRestartRecoveryTarget(
  params: ExpectedRecoveryRead,
): Promise<SessionEntry | undefined> {
  const target = {
    ...params.expected,
    claim: params.expected.claim && { ...params.expected.claim },
    storePath: params.storePath,
    readConsistency: "latest" as const,
  };
  const source = captureSessionEntryMetadataRead(target, () => {});
  const exact = source ? undefined : loadExactSessionEntry(target);
  const entry = source
    ? source.readCurrent()
    : exact?.sessionKey === target.sessionKey
      ? exact.entry
      : undefined;
  return matchesExpectedRecoveryTarget(entry, target, hasMainSessionRecoveryClaim(entry))
    ? entry
    : undefined;
}
