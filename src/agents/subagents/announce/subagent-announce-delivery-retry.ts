import { collectErrorGraphCandidates } from "@openclaw/normalization-core/error-coercion";
import { clampTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { WorkerTaskError } from "@openclaw/worker-runtime";
import { GatewayProtocolRequestError } from "../../../../packages/gateway-client/src/protocol-request.js";
import { ErrorCodes } from "../../../../packages/gateway-protocol/src/schema/error-codes.js";
import { isSessionWorkStartInvalidatedError } from "../../../config/sessions/work-start-error.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveDeliveryNotSentRetryability } from "../../../infra/delivery-recovery.shared.js";
import { isPlatformMessageRejectedError } from "../../../infra/outbound/deliver-types.js";
import {
  findReplaySafeRunAbort,
  isReplaySafeTranscriptConflict,
} from "../../embedded-agent-runner/transcript-conflict.js";
import { isSandboxProvisioningError } from "../../sandbox/provisioning-error.js";
import { isSessionTranscriptTurnMismatchErrorMessage } from "../../sessions/transcript-turn-error.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

const DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;

export class SourceOwnerChangedError extends Error {
  constructor() {
    super("subagent source lifecycle changed before completion delivery");
    this.name = "SourceOwnerChangedError";
  }
}

export function resolveSubagentAnnounceTimeoutMs(cfg: OpenClawConfig): number {
  const configured = cfg.agents?.defaults?.subagents?.announceTimeoutMs;
  return clampTimerTimeoutMs(configured) ?? DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS;
}

export function summarizeDeliveryError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || "error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === undefined || error === null) {
    return "unknown error";
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "error";
  }
}

const PERMANENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS: readonly RegExp[] = [
  /unsupported channel/i,
  /unknown channel/i,
  /chat not found/i,
  /user not found/i,
  /bot.*not.*member/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /recipient is not a valid/i,
  /outbound not configured for channel/i,
  /Session "[^"]+" is archived\. Restore it before starting new work\./i,
  /^managed worktree was removed: .+$/,
];

// The Gateway refused the request itself; resending the same handoff gets the same answer.
const PERMANENT_GATEWAY_REQUEST_ERROR_CODES: ReadonlySet<string> = new Set([
  ErrorCodes.INVALID_REQUEST,
  ErrorCodes.FORBIDDEN,
]);

function isPermanentGatewayRequestRefusal(candidate: unknown): boolean {
  return (
    candidate instanceof GatewayProtocolRequestError &&
    !candidate.retryable &&
    PERMANENT_GATEWAY_REQUEST_ERROR_CODES.has(candidate.gatewayCode)
  );
}

function hasAnnounceErrorMatch(error: unknown, matches: (candidate: unknown) => boolean): boolean {
  return collectErrorGraphCandidates(error, (candidate) => [
    candidate.cause,
    candidate.error,
    candidate.reason,
  ]).some(matches);
}

function hasPermanentAnnounceError(error: unknown): boolean {
  return hasAnnounceErrorMatch(
    error,
    (candidate) =>
      isPlatformMessageRejectedError(candidate) ||
      isPermanentGatewayRequestRefusal(candidate) ||
      isSessionTranscriptTurnMismatchErrorMessage(summarizeDeliveryError(candidate)) ||
      PERMANENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS.some((pattern) =>
        pattern.test(summarizeDeliveryError(candidate)),
      ),
  );
}

export function isPermanentAnnounceDeliveryError(error: unknown): boolean {
  const typedRetryability = resolveDeliveryNotSentRetryability(error);
  if (typedRetryability !== undefined) {
    return !typedRetryability;
  }
  return hasPermanentAnnounceError(error);
}

export function isIncompleteAnnounceAgentResultError(error: unknown): boolean {
  const message = summarizeDeliveryError(error);
  return /(?:incomplete terminal response|code=incomplete_result)\b/i.test(message);
}

export function hasAnnounceSendEvidence(error: unknown): boolean {
  return hasAnnounceErrorMatch(error, (candidate) => {
    const record = asOptionalObjectRecord(candidate);
    return record?.sentBeforeError === true || record?.visibleReplySent === true;
  });
}

/** Classify once; retryable outcomes belong to the existing bounded delivery owner. */
export function classifyAnnounceDeliveryError(
  error: unknown,
  facts: {
    path?: "direct" | "none";
    interruption?: "requester_aborted" | "requester_timed_out";
    replaySafe?: boolean;
    beforeAdmission?: boolean;
    requesterSettle?: boolean;
  } = {},
): SubagentAnnounceDeliveryResult {
  const safeAbort = findReplaySafeRunAbort(error);
  const transcriptConflict = isReplaySafeTranscriptConflict(error);
  const stateConflict = hasAnnounceErrorMatch(
    error,
    (candidate) => asOptionalObjectRecord(candidate)?.code === "item_conflict",
  );
  const reason =
    facts.interruption ??
    (safeAbort
      ? "requester_aborted"
      : hasAnnounceErrorMatch(error, isSessionWorkStartInvalidatedError)
        ? "requester_preparation_changed"
        : hasAnnounceErrorMatch(
              error,
              (candidate) => candidate instanceof WorkerTaskError && candidate.code === "timeout",
            )
          ? "requester_timed_out"
          : transcriptConflict
            ? "requester_transcript_conflict"
            : stateConflict
              ? "requester_state_conflict"
              : undefined);
  return {
    delivered: false,
    path: facts.path ?? "direct",
    reason,
    error:
      error === undefined && facts.interruption
        ? `completion agent ${facts.interruption === "requester_aborted" ? "was aborted" : "timed out"} before delivering a reply`
        : summarizeDeliveryError(error),
    disposition: hasAnnounceSendEvidence(error)
      ? "ambiguous"
      : !isPermanentAnnounceDeliveryError(error) &&
          ((!reason && facts.requesterSettle === false) ||
            facts.beforeAdmission ||
            (reason && facts.replaySafe) ||
            hasAnnounceErrorMatch(
              error,
              (candidate) =>
                candidate instanceof GatewayProtocolRequestError &&
                (candidate.retryable ||
                  (facts.requesterSettle === true &&
                    facts.replaySafe === true &&
                    candidate.gatewayCode === ErrorCodes.UNAVAILABLE)),
            ) ||
            (facts.requesterSettle === true && isSandboxProvisioningError(error)) ||
            safeAbort ||
            transcriptConflict ||
            (!facts.interruption && stateConflict))
        ? "retryable"
        : "permanent_failure",
  };
}
