import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { advanceHarnessCompletionClaim } from "../config/sessions/harness-completion-compaction.js";
import { createSessionWorkStartChangedError } from "../config/sessions/lifecycle.js";
import type {
  HarnessCompletionRecovery,
  RestartRecoveryTerminalDeliveryEvidence,
} from "../config/sessions/restart-recovery-types.js";
import { retainPreparedSessionEntryPredicate } from "../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import {
  prepareSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { captureSessionActorStorageOwner } from "../config/sessions/session-actor-storage-binding.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import type { readAdmittedHarnessCompletionInputFromSqlite } from "../config/sessions/session-harness-completion-source.kernel.js";
import type { HarnessCompletionSourceSnapshot } from "../config/sessions/session-harness-completion-source.types.js";
import { decodeSessionTranscriptWorkerReadError } from "../config/sessions/session-history-worker-errors.js";
import {
  composeSessionSourceAssertion,
  releaseSessionSourceAuthorities,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
} from "../config/sessions/session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "../config/sessions/session-store-target-inventory.js";
import { resolveSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { withSessionTranscriptReadSource } from "../config/sessions/session-transcript-read-source.js";
import { retainSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { sourceDeliveryTargetsMatch } from "../infra/outbound/source-delivery-plan.js";
import {
  readSqliteDatabaseScopedWriteTokenForPath,
  retainSqliteDatabaseWriteScopesForPath,
  sqliteSessionIdWriteScope,
} from "../infra/sqlite-database-admission.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { normalizeInputProvenance } from "../sessions/input-provenance.js";
import { rethrowIncognitoSessionError } from "../state/incognito-session-error.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { assertHarnessCompletionSourceAdmission } from "./agent-harness-completion-scope.js";

export async function readAdmittedHarnessCompletionInputAsync(
  params: Parameters<typeof readAdmittedHarnessCompletionInputFromSqlite>[0],
): Promise<boolean> {
  const memory = captureSessionActorStorageOwner(
    {
      sessionKey: params.claim.requesterSessionKey,
      agentId: params.claim.requesterAgentId,
      storePath: params.storePath,
    },
    { assertCurrent() {}, authorize() {} },
  );
  if (!memory) {
    return withSessionTranscriptReadSource(
      {
        agentId: params.claim.requesterAgentId,
        sessionKey: params.claim.requesterSessionKey,
        sessionId: params.entry.sessionId,
        storePath: params.storePath,
      },
      async ({ owner, scope, expectedIdentity, assertCurrent }) => {
        if (!expectedIdentity) {
          return false;
        }
        const snapshot = await owner.readHarnessCompletionSource({
          env: scope.env,
          claim: params.claim,
          source: {
            agentId: scope.agentId,
            path: scope.storePath,
            databaseIdentity: expectedIdentity.key.slice(5),
            databaseBirthtime: expectedIdentity.birthtime,
          },
          mode: "committed",
          admission: resolveSessionTranscriptReadFence({
            agentId: params.claim.requesterAgentId,
            sessionId: params.claim.sessionId,
          }),
        });
        assertCurrent();
        if (snapshot.readError) {
          throw decodeSessionTranscriptWorkerReadError(snapshot.readError);
        }
        return snapshot.entry?.sessionId === params.claim.sessionId && snapshot.validInput;
      },
    );
  }
  const query = {
    type: "session.completion.read" as const,
    input: {
      sourceRunId: params.claim.sourceRunId,
      claim: params.claim,
      mode: "committed" as const,
      admission: resolveSessionTranscriptReadFence({
        agentId: params.claim.requesterAgentId,
        sessionId: params.claim.sessionId,
      }),
    },
  };
  const snapshot =
    memory.binding?.actor.target.sessionKey === params.claim.requesterSessionKey
      ? memory.binding.actor.storage!.readCurrent(query, memory.authority)
      : memory.owner?.readStorage(params.claim.requesterSessionKey, query, memory.authority);
  return snapshot?.entry?.sessionId === params.claim.sessionId && snapshot.validInput;
}

/** These receipts are stricter than legacy live-return classification: omission is not success. */
export function hasHarnessCompletionFinalReceipt(
  receipt: RestartRecoveryTerminalDeliveryEvidence,
): boolean {
  const target = receipt.deliveryContext;
  if (
    !target?.channel ||
    !target.to ||
    receipt.payloadsTruncated ||
    receipt.messagingToolSentTargetsTruncated ||
    receipt.messagingToolAggregateEvidenceUnaccounted
  ) {
    return false;
  }
  const requiredProvider = normalizeOptionalString(target.channel)?.toLowerCase();
  if (!requiredProvider) {
    return false;
  }
  if (
    receipt.messagingToolSentTargets?.some(
      (sent) =>
        normalizeOptionalString(sent.provider)?.toLowerCase() === requiredProvider &&
        normalizeOptionalString(sent.accountId) === normalizeOptionalString(target.accountId) &&
        sent.sourceReplyFinal === true &&
        sent.visible === true &&
        sourceDeliveryTargetsMatch(sent, target),
    )
  ) {
    return true;
  }
  return (
    receipt.deliveryStatus?.status === "sent" &&
    (receipt.deliveryStatus.resultCount ?? 0) > 0 &&
    receipt.payloads?.some((payload) => payload.visible === true) === true
  );
}

// Initial admission is host-issued; after checkpoint commit the exact session receipt owns recovery.
const admittedClaims = new WeakMap<HarnessCompletionRecovery, () => void>();
function sameCompletionClaim(
  left: HarnessCompletionRecovery | undefined,
  right: HarnessCompletionRecovery,
): boolean {
  return Boolean(
    left &&
    left.taskId === right.taskId &&
    left.taskRunId === right.taskRunId &&
    left.taskStatus === right.taskStatus &&
    left.sourceRunId === right.sourceRunId &&
    left.requesterSessionKey === right.requesterSessionKey &&
    left.requesterAgentId === right.requesterAgentId &&
    left.sessionId === right.sessionId &&
    left.lifecycleRevision === right.lifecycleRevision,
  );
}
export function captureHarnessCompletionRecovery(params: {
  agentId: string;
  sessionKey: string;
  entry: SessionEntry;
  runId: string;
  inputProvenance: unknown;
}): HarnessCompletionRecovery | undefined {
  const provenance = normalizeInputProvenance(params.inputProvenance);
  if (
    !params.runId.startsWith("announce:") ||
    provenance?.kind !== "inter_session" ||
    !["agent_harness_task", "agent_harness_completion"].includes(provenance.sourceTool ?? "") ||
    provenance.sourceChannel !== "internal" ||
    !provenance.sourceSessionKey
  ) {
    return undefined;
  }
  const assertSourceCurrent = assertHarnessCompletionSourceAdmission({
    requesterSessionKey: params.sessionKey,
    requesterAgentId: params.agentId,
    requesterSessionId: params.entry.sessionId,
    requesterLifecycleRevision: params.entry.lifecycleRevision,
    sourceSessionKey: provenance.sourceSessionKey,
    sourceRunId: params.runId,
  });
  const claim: HarnessCompletionRecovery = {
    // Retain the stored receipt's identity fields; they no longer address task_runs.
    taskId: provenance.sourceSessionKey,
    taskRunId: provenance.sourceSessionKey,
    taskStatus: "succeeded",
    sourceRunId: params.runId,
    requesterSessionKey: params.sessionKey,
    requesterAgentId: params.agentId,
    sessionId: params.entry.sessionId,
    ...(params.entry.lifecycleRevision
      ? { lifecycleRevision: params.entry.lifecycleRevision }
      : {}),
  };
  admittedClaims.set(claim, assertSourceCurrent);
  return claim;
}
/** A current session incarnation and its exact admitted completion receipt own further effects. */
export function getOwedHarnessCompletionTask(
  claim: HarnessCompletionRecovery,
  entry: Pick<
    SessionEntry,
    | "sessionId"
    | "lifecycleRevision"
    | "restartRecoveryHarnessCompletion"
    | "restartRecoveryTerminalDeliveryEvidence"
  >,
): HarnessCompletionRecovery | undefined {
  if (entry.sessionId !== claim.sessionId || entry.lifecycleRevision !== claim.lifecycleRevision) {
    return undefined;
  }
  // Historical terminal evidence cannot overrule an explicitly replaced current task.
  if (
    entry.restartRecoveryHarnessCompletion &&
    !sameCompletionClaim(entry.restartRecoveryHarnessCompletion, claim)
  ) {
    return undefined;
  }
  if (
    entry.restartRecoveryTerminalDeliveryEvidence?.some(
      (receipt) =>
        sameCompletionClaim(receipt.harnessCompletion, claim) &&
        hasHarnessCompletionFinalReceipt(receipt),
    )
  ) {
    return undefined;
  }
  if (
    sameCompletionClaim(entry.restartRecoveryHarnessCompletion, claim) ||
    entry.restartRecoveryTerminalDeliveryEvidence?.some((receipt) =>
      sameCompletionClaim(receipt.harnessCompletion, claim),
    )
  ) {
    return claim;
  }
  const assertSourceCurrent = admittedClaims.get(claim);
  if (!assertSourceCurrent) {
    return undefined;
  }
  try {
    assertSourceCurrent();
    return claim;
  } catch (error) {
    rethrowIncognitoSessionError(error);
    return undefined;
  }
}

/** The existing admitted execution guard rechecks this before execution and delegated effects. */
export function createHarnessCompletionSourceAssertion(params: {
  claim: HarnessCompletionRecovery;
  storePath: string;
  mode?: "admission" | "committed";
  priorAssertion?: SessionSourceAssertion;
}): SessionSourceAssertion {
  let claim = params.claim;
  const onSessionCompactionCommitted: NonNullable<
    SessionSourceAssertion["onSessionCompactionCommitted"]
  > = (transition, entry) => {
    const next = advanceHarnessCompletionClaim(claim, transition);
    if (
      !next &&
      claim.sessionId === transition.current.sessionId &&
      claim.lifecycleRevision === transition.current.lifecycleRevision &&
      isDeepStrictEqual(entry.restartRecoveryHarnessCompletion, claim)
    ) {
      return;
    }
    if (
      !next ||
      entry.sessionId !== transition.current.sessionId ||
      entry.lifecycleRevision !== transition.current.lifecycleRevision ||
      !isDeepStrictEqual(entry.restartRecoveryHarnessCompletion, next)
    ) {
      throw createSessionWorkStartChangedError(claim.requesterSessionKey);
    }
    claim = next;
  };
  const target = {
    agentId: claim.requesterAgentId,
    sessionKey: claim.requesterSessionKey,
    storePath: params.storePath,
  };
  const memory = captureSessionActorStorageOwner(target, { assertCurrent() {}, authorize() {} });
  if (memory) {
    const assertCurrent = () => {
      const query = {
        type: "session.completion.read" as const,
        input: {
          sourceRunId: claim.sourceRunId,
          claim,
          mode: params.mode,
          admission: resolveSessionTranscriptReadFence({
            agentId: target.agentId,
            sessionId: claim.sessionId,
          }),
        },
      };
      const snapshot =
        memory.binding?.actor.target.sessionKey === target.sessionKey
          ? memory.binding.actor.storage!.readCurrent(query, memory.authority)
          : memory.owner?.readStorage(target.sessionKey, query, memory.authority);
      if (
        !snapshot?.entry ||
        !snapshot.validInput ||
        !getOwedHarnessCompletionTask(claim, snapshot.entry)
      ) {
        throw createSessionWorkStartChangedError(target.sessionKey);
      }
    };
    const prepare = async (): Promise<PreparedSessionSourceAuthority> => {
      const preparedClaim = claim;
      return {
        assertCurrent() {
          if (claim !== preparedClaim) {
            throw createSessionWorkStartChangedError(target.sessionKey);
          }
          assertCurrent();
        },
        checks: [],
      };
    };
    return composeSessionSourceAssertion([
      params.priorAssertion,
      Object.assign(assertCurrent, {
        onSessionCompactionCommitted,
        prepareSessionSource: prepare,
        prepareSessionSourceScope: prepare,
      }),
    ]);
  }
  const refuse = (): never => {
    throw createSessionWorkStartChangedError(target.sessionKey);
  };
  const prepareSnapshot = (
    preparedClaim: HarnessCompletionRecovery,
    snapshot: HarnessCompletionSourceSnapshot,
    source: CapturedSessionEntryReadSource & { databaseIdentity: string },
    assertStorageCurrent: () => void,
    release?: () => void | Promise<void>,
  ): PreparedSessionSourceAuthority => {
    assertStorageCurrent();
    if (
      claim !== preparedClaim ||
      !snapshot.entry ||
      !getOwedHarnessCompletionTask(preparedClaim, snapshot.entry)
    ) {
      refuse();
    }
    if (snapshot.readError) {
      throw decodeSessionTranscriptWorkerReadError(snapshot.readError);
    }
    if (!snapshot.validInput) {
      refuse();
    }
    const fields = [
      "sessionId",
      "lifecycleRevision",
      "restartRecoveryHarnessCompletion",
      "restartRecoveryTerminalDeliveryEvidence",
    ] as const;
    const retained = retainPreparedSessionEntryPredicate({
      databaseIdentity: `file:${source.databaseIdentity}`,
      sessionKey: target.sessionKey,
      entry: snapshot.entry,
      matches: (before, after) =>
        fields.every((field) => isDeepStrictEqual(before?.[field], after?.[field])),
    });
    return {
      assertCurrent() {
        assertStorageCurrent();
        if (
          claim !== preparedClaim ||
          !retained.isCurrent() ||
          !snapshot.entry ||
          !getOwedHarnessCompletionTask(preparedClaim, snapshot.entry)
        ) {
          refuse();
        }
      },
      checks: [
        {
          predicate: {
            source,
            sessionKey: target.sessionKey,
            fields: [...fields],
            expected: snapshot.entry,
            ...(snapshot.version
              ? { transcript: { sessionId: preparedClaim.sessionId, version: snapshot.version } }
              : {}),
          },
          refuse,
        },
      ],
      release: () => releaseSessionSourceAuthorities([retained, { release }]),
    };
  };
  const assertSource = () => {
    // The durable requester receipt outlives the original source admission.
    // Each effect scope prepares and validates that receipt before its callback.
  };
  const prepareSessionSource = async (
    checkWriteToken = false,
  ): Promise<PreparedSessionSourceAuthority> => {
    const preparedClaim = claim;
    const env = captureSessionTranscriptStorageEnvironment(process.env);
    const candidates = captureSessionStoreReadCandidates(params.storePath);
    const identities = captureSessionStoreCandidateIdentities(candidates);
    const admission = resolveSessionTranscriptReadFence({
      agentId: preparedClaim.requesterAgentId,
      sessionId: preparedClaim.sessionId,
    });
    const resolved = await prepareSqliteScope({
      agentId: preparedClaim.requesterAgentId,
      sessionKey: preparedClaim.requesterSessionKey,
      storePath: params.storePath,
      env,
    });
    const options = toDatabaseOptions(resolved);
    const path = resolveOpenClawAgentSqlitePath(options);
    const identity = identities.get(assertSessionStoreReadCandidate(path, candidates));
    if (!identity?.key.startsWith("file:")) {
      return refuse();
    }
    const source = {
      agentId: options.agentId,
      path,
      databaseIdentity: identity.key.slice(5),
      databaseBirthtime: identity.birthtime,
    };
    const retained = retainSessionHistoryWorkerDatabase({ ...options, path });
    let releaseWriteScopes: (() => void) | undefined;
    const resources = [retained, { release: () => releaseWriteScopes?.() }];
    try {
      const writeScopes = [target.sessionKey, sqliteSessionIdWriteScope(preparedClaim.sessionId)];
      if (checkWriteToken) {
        releaseWriteScopes = retainSqliteDatabaseWriteScopesForPath(path, writeScopes);
        if (!releaseWriteScopes) {
          refuse();
        }
      }
      const snapshot = await retained.owner.readHarnessCompletionSource({
        env,
        claim: preparedClaim,
        mode: params.mode,
        source,
        ...(admission ? { admission } : {}),
      });
      return prepareSnapshot(
        preparedClaim,
        snapshot,
        source,
        () => {
          retained.owner.assertCurrent();
          assertSessionStoreReadCandidate(path, candidates);
          assertExistingDatabaseIdentity(path, identity.key, identity.birthtime);
          // Worker mutations validate their predicates in the committing transaction.
          // External effects instead consume the read receipt at their final callback.
          if (
            checkWriteToken &&
            (snapshot.writeToken === undefined ||
              readSqliteDatabaseScopedWriteTokenForPath(path, writeScopes) !== snapshot.writeToken)
          ) {
            refuse();
          }
        },
        () => releaseSessionSourceAuthorities(resources),
      );
    } catch (error) {
      await releaseSessionSourceAuthorities(resources, [error]);
      throw error;
    }
  };
  return composeSessionSourceAssertion([
    params.priorAssertion,
    Object.assign(assertSource, {
      onSessionCompactionCommitted,
      prepareSessionSourceScope: () => prepareSessionSource(true),
      prepareSessionSource,
    }),
  ]);
}
