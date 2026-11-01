import { collectErrorGraphCandidates } from "@openclaw/normalization-core/error-coercion";
import { clampTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveDeliveryNotSentRetryability } from "../../../infra/delivery-recovery.shared.js";
import { isPlatformMessageRejectedError } from "../../../infra/outbound/deliver-types.js";
import { isSessionTranscriptTurnMismatchErrorMessage } from "../../sessions/transcript-turn-error.js";

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
];

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
