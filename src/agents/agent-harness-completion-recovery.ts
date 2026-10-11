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
import { getSessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import { readAdmittedHarnessCompletionInput as readNativeAdmittedHarnessCompletionInput } from "../config/sessions/session-harness-completion-source.kernel.js";
import type { HarnessCompletionSourceSnapshot } from "../config/sessions/session-harness-completion-source.types.js";
import { decodeSessionTranscriptWorkerReadError } from "../config/sessions/session-history-worker-errors.js";
import { captureIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
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
import { retainSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "../config/sessions/transcript-target-binding.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { sourceDeliveryTargetsMatch } from "../infra/outbound/source-delivery-plan.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { normalizeInputProvenance } from "../sessions/input-provenance.js";
import { rethrowIncognitoSessionError } from "../state/incognito-session-error.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { assertHarnessCompletionSourceAdmission } from "./agent-harness-completion-scope.js";

export function readAdmittedHarnessCompletionInput(
  params: Parameters<typeof readNativeAdmittedHarnessCompletionInput>[0],
): boolean {
  const memory = getSessionActorStorageBinding({
    sessionKey: params.claim.requesterSessionKey,
    agentId: params.claim.requesterAgentId,
    storePath: params.storePath,
  });
  if (!memory) {
    return readNativeAdmittedHarnessCompletionInput(params);
  }
  const snapshot = memory.actor.storage!.readCurrent(
    {
      type: "session.completion.read",
      input: {
        sourceRunId: params.claim.sourceRunId,
        claim: params.claim,
        mode: "committed",
        admission: resolveSessionTranscriptReadFence({
          agentId: params.claim.requesterAgentId,
          sessionId: params.claim.sessionId,
        }),
      },
    },
    memory.authority,
  );
  return snapshot.entry?.sessionId === params.claim.sessionId && snapshot.validInput;
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
  priorAssertion?: SessionSourceAssertion;
}): SessionSourceAssertion {
  const target = {
    agentId: params.claim.requesterAgentId,
    sessionKey: params.claim.requesterSessionKey,
    storePath: params.storePath,
  };
  const memory = getSessionActorStorageBinding(target);
  if (memory) {
    const assertCurrent = () => {
      const snapshot = memory.actor.storage!.readCurrent(
        {
          type: "session.completion.read",
          input: {
            sourceRunId: params.claim.sourceRunId,
            claim: params.claim,
            admission: resolveSessionTranscriptReadFence({
              agentId: target.agentId,
              sessionId: params.claim.sessionId,
            }),
          },
        },
        memory.authority,
      );
      if (
        !snapshot.entry ||
        !snapshot.validInput ||
        !getOwedHarnessCompletionTask(params.claim, snapshot.entry)
      ) {
        throw createSessionWorkStartChangedError(target.sessionKey);
      }
    };
    const prepare = async (): Promise<PreparedSessionSourceAuthority> => ({
      assertCurrent,
      checks: [],
    });
    return composeSessionSourceAssertion([
      params.priorAssertion,
      Object.assign(assertCurrent, {
        prepareSessionSource: prepare,
        prepareSessionSourceScope: prepare,
      }),
    ]);
  }
  const binding = captureIncognitoSessionBinding(target);
  const capturedClaim = binding?.actor.sessions.captureCurrent(target.sessionKey);
  const refuse = (): never => {
    throw createSessionWorkStartChangedError(target.sessionKey);
  };
  const assertIncognitoClaim = () => {
    if (!binding) {
      return refuse();
    }
    binding.admissionSignal?.throwIfAborted();
    binding.actor.assertReadable();
    capturedClaim?.assertCurrent();
    const entry = binding.actor.sessions.readSteering(target.sessionKey);
    if (!entry || !getOwedHarnessCompletionTask(params.claim, entry)) {
      return refuse();
    }
    return entry;
  };
  const prepareIncognitoSource = async (): Promise<PreparedSessionSourceAuthority> => {
    if (!binding) {
      return refuse();
    }
    assertIncognitoClaim();
    const retained = await binding.actor.sessions.retainCompletionSource(
      { assertCurrent: assertIncognitoClaim },
      {
        sessionKey: target.sessionKey,
        sessionId: params.claim.sessionId,
        lifecycleRevision: params.claim.lifecycleRevision,
        claim: params.claim,
        admission: resolveSessionTranscriptReadFence({
          agentId: target.agentId,
          sessionId: params.claim.sessionId,
        }),
      },
      binding.admissionSignal,
    );
    return {
      assertCurrent: () => {
        assertIncognitoClaim();
        retained.assertCurrent();
      },
      checks: [],
      release: () => retained.release(),
    };
  };
  const prepareSnapshot = (
    snapshot: HarnessCompletionSourceSnapshot,
    source: CapturedSessionEntryReadSource,
    assertStorageCurrent: () => void,
    release?: () => void | Promise<void>,
  ): PreparedSessionSourceAuthority => {
    const assertCurrent = () => {
      assertStorageCurrent();
      if (!snapshot.entry || !getOwedHarnessCompletionTask(params.claim, snapshot.entry)) {
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
            sessionKey: target.sessionKey,
            fields: [
              "sessionId",
              "lifecycleRevision",
              "restartRecoveryHarnessCompletion",
              "restartRecoveryTerminalDeliveryEvidence",
              "restartRecoveryDeliveryRunId",
              "restartRecoveryRuns",
            ],
            expected: snapshot.entry,
            ...(snapshot.version
              ? { transcript: { sessionId: params.claim.sessionId, version: snapshot.version } }
              : {}),
          },
          refuse,
        },
      ],
      release,
    };
  };
  const assertSource = () => {
    if (binding) {
      const entry = assertIncognitoClaim();
      // Recovery requires an async prepared scope. The original host claim
      // precedes its transcript commit and retains its existing admission rule.
      if (entry.restartRecoveryDeliveryRunId !== params.claim.sourceRunId) {
        refuse();
      }
      return;
    }
    const current = loadExactSessionEntry({
      ...target,
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
      prepareSessionSourceScope: binding ? prepareIncognitoSource : undefined,
      async prepareSessionSource() {
        const { claim } = params;
        if (binding) {
          return prepareIncognitoSource();
        }
        const env = captureSessionTranscriptStorageEnvironment(process.env);
        const candidates = captureSessionStoreReadCandidates(params.storePath);
        const identities = captureSessionStoreCandidateIdentities(candidates);
        const admission = resolveSessionTranscriptReadFence({
          agentId: claim.requesterAgentId,
          sessionId: claim.sessionId,
        });
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
          return prepareSnapshot(
            snapshot,
            source,
            () => {
              retained.owner.assertCurrent();
              assertSessionStoreReadCandidate(path, candidates);
              assertExistingDatabaseIdentity(path, identity.key, identity.birthtime);
            },
            retained.release,
          );
        } catch (error) {
          await releaseSessionSourceAuthorities([retained], [error]);
          throw error;
        }
      },
    }),
  ]);
}
