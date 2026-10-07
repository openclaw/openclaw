import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createSessionWorkStartChangedError } from "../config/sessions/lifecycle.js";
import type {
  HarnessCompletionRecovery,
  RestartRecoveryTerminalDeliveryEvidence,
} from "../config/sessions/restart-recovery-types.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import {
  prepareSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { readAdmittedHarnessCompletionInput } from "../config/sessions/session-harness-completion-source.kernel.js";
import { decodeSessionTranscriptWorkerReadError } from "../config/sessions/session-history-worker-errors.js";
import {
  composeSessionSourceAssertion,
  releaseSessionSourceAuthorities,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
} from "../config/sessions/session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "../config/sessions/session-store-target-inventory.js";
import { resolveSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { retainSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { sourceDeliveryTargetsMatch } from "../infra/outbound/source-delivery-plan.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { normalizeInputProvenance } from "../sessions/input-provenance.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { assertHarnessCompletionSourceAdmission } from "./agent-harness-completion-scope.js";

export { readAdmittedHarnessCompletionInput } from "../config/sessions/session-harness-completion-source.kernel.js";

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
  entry: SessionEntry,
): HarnessCompletionRecovery | undefined {
  if (entry.sessionId !== claim.sessionId || entry.lifecycleRevision !== claim.lifecycleRevision) {
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
  } catch {
    return undefined;
  }
}

/** The existing admitted execution guard rechecks this before execution and delegated effects. */
export function createHarnessCompletionSourceAssertion(params: {
  claim: HarnessCompletionRecovery;
  storePath: string;
  priorAssertion?: SessionSourceAssertion;
}): SessionSourceAssertion {
  const assertSource = () => {
    const current = loadExactSessionEntry({
      agentId: params.claim.requesterAgentId,
      sessionKey: params.claim.requesterSessionKey,
      storePath: params.storePath,
      readConsistency: "latest",
    });
    // The original host claim precedes transcript commit. A recovery attempt
    // already has a committed source and must keep it valid in its read fence.
    if (
      !current ||
      current.sessionKey !== params.claim.requesterSessionKey ||
      !getOwedHarnessCompletionTask(params.claim, current.entry) ||
      (current.entry.restartRecoveryDeliveryRunId !== params.claim.sourceRunId &&
        !readAdmittedHarnessCompletionInput({
          claim: params.claim,
          entry: current.entry,
          storePath: params.storePath,
          operationalRunId: current.entry.restartRecoveryDeliveryRunId,
        }))
    ) {
      throw createSessionWorkStartChangedError(params.claim.requesterSessionKey);
    }
  };
  return composeSessionSourceAssertion([
    params.priorAssertion,
    Object.assign(assertSource, {
      async prepareSessionSource() {
        const { claim } = params;
        const env = captureSessionTranscriptStorageEnvironment(process.env);
        const candidates = captureSessionStoreReadCandidates(params.storePath);
        const identities = captureSessionStoreCandidateIdentities(candidates);
        const admission = resolveSessionTranscriptReadFence({
          agentId: claim.requesterAgentId,
          sessionId: claim.sessionId,
        });
        const refuse = (): never => {
          throw createSessionWorkStartChangedError(claim.requesterSessionKey);
        };
        const resolved = await prepareSqliteScope({
          agentId: claim.requesterAgentId,
          sessionKey: claim.requesterSessionKey,
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
        try {
          const snapshot = await retained.owner.readHarnessCompletionSource({
            env,
            claim,
            source,
            ...(admission ? { admission } : {}),
          });
          const assertCurrent = () => {
            retained.owner.assertCurrent();
            assertSessionStoreReadCandidate(path, candidates);
            assertExistingDatabaseIdentity(path, identity.key, identity.birthtime);
            if (!snapshot.entry || !getOwedHarnessCompletionTask(claim, snapshot.entry)) {
              refuse();
            }
            if (snapshot.readError) {
              throw decodeSessionTranscriptWorkerReadError(snapshot.readError);
            }
            if (!snapshot.validInput) {
              refuse();
            }
          };
          assertCurrent();
          return {
            assertCurrent,
            checks: [
              {
                predicate: {
                  source,
                  sessionKey: claim.requesterSessionKey,
                  fields: [
                    "sessionId",
                    "lifecycleRevision",
                    "restartRecoveryHarnessCompletion",
                    "restartRecoveryTerminalDeliveryEvidence",
                    "restartRecoveryDeliveryRunId",
                    "restartRecoveryRuns",
                  ] satisfies (keyof SessionEntry)[],
                  expected: snapshot.entry,
                  ...(snapshot.version
                    ? {
                        transcript: { sessionId: claim.sessionId, version: snapshot.version },
                      }
                    : {}),
                },
                refuse,
              },
            ],
            release: retained.release,
          };
        } catch (error) {
          await releaseSessionSourceAuthorities([retained], [error]);
          throw error;
        }
      },
    }),
  ]);
}
