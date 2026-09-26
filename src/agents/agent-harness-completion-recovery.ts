import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createSessionWorkStartChangedError } from "../config/sessions/lifecycle.js";
import type {
  HarnessCompletionRecovery,
  RestartRecoveryTerminalDeliveryEvidence,
} from "../config/sessions/restart-recovery-types.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { everySessionTranscriptUserInputFrom } from "../config/sessions/session-accessor.sqlite-active-events.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { sourceDeliveryTargetsMatch } from "../infra/outbound/source-delivery-plan.js";
import { normalizeInputProvenance } from "../sessions/input-provenance.js";
import { assertHarnessCompletionSourceAdmission } from "./agent-harness-completion-scope.js";

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

/** The exact source input must already be in this transcript, before any recovery input. */
function hasAdmittedHarnessCompletionInput(
  claim: HarnessCompletionRecovery,
  messages: readonly unknown[],
  operationalRunId?: string,
  priorRunIds: readonly string[] = [],
): boolean {
  const sources = messages.filter((message) => {
    const record = asOptionalRecord(message);
    const provenance = normalizeInputProvenance(record?.provenance);
    return (
      record?.role === "user" &&
      record.idempotencyKey === `${claim.sourceRunId}:user` &&
      asOptionalRecord(record["__openclaw"])?.runId === claim.sourceRunId &&
      provenance?.kind === "inter_session" &&
      provenance.sourceChannel === "internal" &&
      ["agent_harness_task", "agent_harness_completion"].includes(provenance.sourceTool ?? "") &&
      provenance.sourceSessionKey === claim.taskRunId
    );
  });
  if (sources.length !== 1) {
    return false;
  }
  const sourceIndex = messages.indexOf(sources[0]);
  const allowedRunIds = new Set([operationalRunId, ...priorRunIds].filter(Boolean));
  return messages.slice(sourceIndex + 1).every((message) => {
    const record = asOptionalRecord(message);
    if (record?.role !== "user") {
      return true;
    }
    const provenance = normalizeInputProvenance(record.provenance);
    const annotatedRunId = asOptionalRecord(record["__openclaw"])?.runId;
    // The recorder commits the exact input key before native mirroring adds
    // runId. Only this admitted recovery (or an admitted predecessor) may join;
    // a present mirror annotation must agree with the submitted input identity.
    const runId =
      typeof record.idempotencyKey === "string"
        ? [...allowedRunIds].find((id) => record.idempotencyKey === `${id}:user`)
        : annotatedRunId;
    return (
      typeof runId === "string" &&
      allowedRunIds.has(runId) &&
      (annotatedRunId == null || annotatedRunId === runId) &&
      provenance?.kind === "internal_system" &&
      provenance.sourceTool === "main_session_restart_recovery" &&
      provenance.sourceSessionKey === claim.requesterSessionKey
    );
  });
}

/** Exact source lookup is independent of the display tail used to choose recovery policy. */
export function readAdmittedHarnessCompletionInput(params: {
  claim: HarnessCompletionRecovery;
  entry: SessionEntry;
  storePath: string;
  operationalRunId?: string;
}): boolean {
  const scope = {
    agentId: params.claim.requesterAgentId,
    sessionKey: params.claim.requesterSessionKey,
    sessionId: params.entry.sessionId,
    storePath: params.storePath,
  };
  const priorRunIds = (params.entry.restartRecoveryRuns ?? [])
    .filter((run) => Boolean(run.lifecycleGeneration))
    .map((run) => run.runId);
  let source: unknown;
  return everySessionTranscriptUserInputFrom(
    scope,
    `${params.claim.sourceRunId}:user`,
    (message) => {
      if (source === undefined) {
        source = message;
        return hasAdmittedHarnessCompletionInput(params.claim, [source]);
      }
      return hasAdmittedHarnessCompletionInput(
        params.claim,
        [source, message],
        params.operationalRunId,
        priorRunIds,
      );
    },
  );
}

/** The existing admitted execution guard rechecks this before execution and delegated effects. */
export function createHarnessCompletionSourceAssertion(params: {
  claim: HarnessCompletionRecovery;
  storePath: string;
  priorAssertion?: () => void;
}): () => void {
  return () => {
    params.priorAssertion?.();
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
}
