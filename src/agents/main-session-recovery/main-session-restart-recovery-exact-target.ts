import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  hasMainSessionRecoveryClaim,
  isMainRestartRecoveryCandidate,
} from "../../config/sessions/restart-recovery-state.js";
import { loadExactSessionEntry } from "../../config/sessions/session-accessor.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import {
  readSessionEntryReadOnlyInWorker,
  withSessionEntriesFromStoreInWorker,
  withSessionStoreReaderInWorker,
} from "../../config/sessions/session-entry-read-runtime.js";
import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import type { ExpectedRestartRecoveryTarget } from "./main-session-restart-recovery-shared.js";
import { resolveRestartRecoveryDispatchIdentity } from "./main-session-restart-recovery-target.js";

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

/** Keep one recovery read current through admission using the owner's write receipts. */
export async function prepareExpectedRestartRecoveryCurrent(
  params: ExpectedRecoveryRead,
): Promise<{ isCurrent: () => boolean; release: () => void }> {
  const expected = {
    ...params.expected,
    claim: params.expected.claim && { ...params.expected.claim },
  };
  const target = {
    ...expected,
    storePath: params.storePath,
    agentId: resolveRestartRecoveryDispatchIdentity({
      ...expected,
      storePath: params.storePath,
    }).agentId,
  };
  const source = captureIncognitoSessionSource(target);
  if (source && "kind" in source) {
    return {
      isCurrent: () => {
        source.assertCurrent();
        return false;
      },
      release() {},
    };
  }
  if (source) {
    const claim = source.actor.sessions.captureCurrent(target.sessionKey);
    return {
      isCurrent: () => {
        source.admissionSignal?.throwIfAborted();
        claim.assertCurrent();
        const current = source.actor.sessions.readSteering(target.sessionKey);
        return matchesExpectedRecoveryTarget(current, expected, current?.hasRecoveryClaim === true);
      },
      release() {},
    };
  }
  if (isIncognitoSessionKey(target.sessionKey)) {
    return {
      isCurrent: () => {
        const exact = loadExactSessionEntry({ ...target, readConsistency: "latest" });
        const current = exact?.sessionKey === target.sessionKey ? exact.entry : undefined;
        return matchesExpectedRecoveryTarget(
          current,
          expected,
          hasMainSessionRecoveryClaim(current),
        );
      },
      release() {},
    };
  }
  let release = () => {};
  let databaseIdentity: string | undefined;
  try {
    return await withSessionEntriesFromStoreInWorker(
      { ...target, sessionKeys: [target.sessionKey], projection: "list" },
      async (read) => {
        const entry = read.result.entries.find(
          ({ sessionKey }) => sessionKey === target.sessionKey,
        )?.entry;
        const matches = (current: SessionEntry | undefined) =>
          matchesExpectedRecoveryTarget(current, expected, hasMainSessionRecoveryClaim(current));
        if (!databaseIdentity || !matches(entry)) {
          return { isCurrent: () => false, release() {} };
        }
        const retained = retainPreparedSessionEntryPredicate({
          databaseIdentity,
          sessionKey: target.sessionKey,
          entry,
          matches: (_before, current) => matches(current),
        });
        release = retained.release;
        return { isCurrent: retained.isCurrent, release };
      },
      false,
      (_database, identity) => {
        databaseIdentity = identity.key;
      },
    );
  } catch (error) {
    release();
    throw error;
  }
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
  const source = captureIncognitoSessionSource(target);
  const exact = source
    ? undefined
    : await withSessionStoreReaderInWorker(target, ({ reader, database, continuation }) =>
        reader.readExactEntries({
          sessionKeys: [target.sessionKey],
          env: database.env,
          continuation,
        }),
      );
  const entry = source
    ? await readSessionEntryReadOnlyInWorker(target)
    : exact?.entries.find(({ sessionKey }) => sessionKey === target.sessionKey)?.entry;
  return matchesExpectedRecoveryTarget(entry, target, hasMainSessionRecoveryClaim(entry))
    ? entry
    : undefined;
}
