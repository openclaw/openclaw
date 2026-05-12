import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import type {
  FinalDeliveryError,
  FinalDeliveryState,
  FinalDeliveryTerminalReason,
} from "./subagent-final-delivery.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type {
  FinalDeliveryError,
  FinalDeliveryState,
  FinalDeliveryTerminalReason,
} from "./subagent-final-delivery.types.js";

type FinalDeliveryEvent =
  | { type: "delivered"; deliveredAt: number }
  | {
      type: "failed";
      now: number;
      error: FinalDeliveryError;
      retryDelayMs: number;
      hardExpiryAt?: number;
    }
  | { type: "hard_expiry_reached"; expiredAt: number }
  | { type: "not_required" };

export function isFinalDeliveryTerminal(state: FinalDeliveryState): boolean {
  return (
    state.kind === "not_required" ||
    state.kind === "delivered" ||
    state.kind === "terminal_failed" ||
    state.kind === "expired"
  );
}

export function finalDeliveryTerminalReason(
  state: FinalDeliveryState,
): FinalDeliveryTerminalReason | undefined {
  if (state.kind === "terminal_failed") {
    return state.reason;
  }
  if (state.kind === "expired") {
    return "expiry";
  }
  return undefined;
}

export function normalizeFinalDeliveryError(
  delivery: SubagentAnnounceDeliveryResult,
  fallbackMessage: string,
): FinalDeliveryError {
  const message = delivery.error?.trim() || fallbackMessage;
  const retryability =
    delivery.retryable === false
      ? "permanent"
      : delivery.retryable === true
        ? "transient"
        : "unknown";
  return {
    message,
    retryability,
    path: delivery.path,
  };
}

export function reduceFinalDeliveryState(
  state: FinalDeliveryState,
  event: FinalDeliveryEvent,
): FinalDeliveryState {
  if (event.type === "not_required") {
    return { kind: "not_required" };
  }
  if (event.type === "delivered") {
    return { kind: "delivered", deliveredAt: event.deliveredAt };
  }
  if (event.type === "hard_expiry_reached") {
    return lastErrorForState(state)
      ? { kind: "expired", expiredAt: event.expiredAt, lastError: lastErrorForState(state) }
      : { kind: "expired", expiredAt: event.expiredAt };
  }
  if (event.error.retryability === "permanent") {
    return { kind: "terminal_failed", reason: "permanent-failure", error: event.error };
  }
  if (event.hardExpiryAt !== undefined && event.now >= event.hardExpiryAt) {
    return { kind: "expired", expiredAt: event.now, lastError: event.error };
  }
  const attemptCount = attemptCountForState(state) + 1;
  return {
    kind: "retrying",
    attemptCount,
    nextRetryAt: event.now + event.retryDelayMs,
    lastError: event.error,
  };
}

export function loadFinalDeliveryState(params: {
  entry: SubagentRunRecord;
  now: number;
  hardExpiryMs: number;
}): FinalDeliveryState {
  const { entry, now, hardExpiryMs } = params;
  if (entry.expectsCompletionMessage !== true) {
    return { kind: "not_required" };
  }
  if (typeof entry.completionAnnouncedAt === "number") {
    return { kind: "delivered", deliveredAt: entry.completionAnnouncedAt };
  }
  const hardExpiryAt = typeof entry.endedAt === "number" ? entry.endedAt + hardExpiryMs : undefined;
  const stored = entry.finalDeliveryState;
  if (
    stored &&
    stored.kind !== "not_required" &&
    stored.kind !== "delivered" &&
    stored.kind !== "terminal_failed" &&
    stored.kind !== "expired" &&
    hardExpiryAt !== undefined &&
    now >= hardExpiryAt
  ) {
    return reduceFinalDeliveryState(stored, {
      type: "hard_expiry_reached",
      expiredAt: now,
    });
  }
  if (stored) {
    return stored;
  }
  if (hardExpiryAt !== undefined && now >= hardExpiryAt) {
    return { kind: "expired", expiredAt: now };
  }
  if (entry.pendingFinalDelivery === true || typeof entry.endedAt === "number") {
    const lastError = legacyFinalDeliveryError(entry);
    if (lastError?.retryability === "permanent") {
      return { kind: "terminal_failed", reason: "permanent-failure", error: lastError };
    }
    const attemptCount = entry.pendingFinalDeliveryAttemptCount ?? entry.announceRetryCount ?? 0;
    return lastError
      ? { kind: "pending", attemptCount, lastError }
      : { kind: "pending", attemptCount };
  }
  return { kind: "pending", attemptCount: 0 };
}

export function recordFinalDeliverySuccess(entry: SubagentRunRecord, deliveredAt: number): void {
  writeFinalDeliveryState(entry, { kind: "delivered", deliveredAt }, deliveredAt);
}

export function recordFinalDeliveryFailure(params: {
  entry: SubagentRunRecord;
  now: number;
  hardExpiryMs: number;
  retryDelayMs: number;
  error: FinalDeliveryError;
}): FinalDeliveryState {
  const current = loadFinalDeliveryState({
    entry: params.entry,
    now: params.now,
    hardExpiryMs: params.hardExpiryMs,
  });
  const hardExpiryAt =
    typeof params.entry.endedAt === "number"
      ? params.entry.endedAt + params.hardExpiryMs
      : undefined;
  const next = reduceFinalDeliveryState(current, {
    type: "failed",
    now: params.now,
    error: params.error,
    retryDelayMs: params.retryDelayMs,
    hardExpiryAt,
  });
  writeFinalDeliveryState(params.entry, next, params.now);
  return next;
}

export function writeFinalDeliveryState(
  entry: SubagentRunRecord,
  state: FinalDeliveryState,
  now: number,
): void {
  entry.finalDeliveryState = state;
  if (state.kind === "not_required") {
    clearPendingFinalDelivery(entry);
    return;
  }
  if (state.kind === "delivered") {
    entry.completionAnnouncedAt = state.deliveredAt;
    clearPendingFinalDelivery(entry);
    entry.lastAnnounceDeliveryError = undefined;
    entry.lastAnnounceDeliveryRetryable = undefined;
    return;
  }
  if (state.kind === "terminal_failed") {
    clearPendingFinalDelivery(entry);
    entry.lastAnnounceDeliveryError = state.error.message;
    entry.lastAnnounceDeliveryRetryable = false;
    return;
  }
  if (state.kind === "expired") {
    clearPendingFinalDelivery(entry);
    entry.lastAnnounceDeliveryError = state.lastError?.message ?? entry.lastAnnounceDeliveryError;
    entry.lastAnnounceDeliveryRetryable = state.lastError
      ? state.lastError.retryability !== "permanent"
      : entry.lastAnnounceDeliveryRetryable;
    return;
  }
  entry.pendingFinalDelivery = true;
  entry.pendingFinalDeliveryCreatedAt ??= now;
  entry.pendingFinalDeliveryLastAttemptAt = now;
  entry.pendingFinalDeliveryAttemptCount = state.attemptCount;
  entry.pendingFinalDeliveryLastError = state.lastError?.message ?? null;
  entry.pendingFinalDeliveryLastRetryable = state.lastError
    ? state.lastError.retryability !== "permanent"
    : undefined;
  entry.lastAnnounceDeliveryError = state.lastError?.message;
  entry.lastAnnounceDeliveryRetryable = state.lastError
    ? state.lastError.retryability !== "permanent"
    : undefined;
  if (state.kind === "retrying") {
    entry.lastAnnounceRetryAt = now;
    entry.announceRetryCount = state.attemptCount;
  }
}

export function resolveFinalDeliveryResumeDecision(params: {
  entry: SubagentRunRecord;
  now: number;
  hardExpiryMs: number;
}):
  | { kind: "complete"; reason?: FinalDeliveryTerminalReason }
  | { kind: "attempt" }
  | { kind: "schedule"; delayMs: number } {
  const state = loadFinalDeliveryState(params);
  const terminalReason = finalDeliveryTerminalReason(state);
  if (terminalReason) {
    writeFinalDeliveryState(params.entry, state, params.now);
    return { kind: "complete", reason: terminalReason };
  }
  if (state.kind === "not_required" || state.kind === "delivered") {
    writeFinalDeliveryState(params.entry, state, params.now);
    return { kind: "complete" };
  }
  if (state.kind === "retrying" && params.now < state.nextRetryAt) {
    return { kind: "schedule", delayMs: Math.max(1, state.nextRetryAt - params.now) };
  }
  return { kind: "attempt" };
}

export function hasRetryablePendingFinalDeliveryPayload(params: {
  entry: SubagentRunRecord;
  now: number;
  hardExpiryMs: number;
}): boolean {
  const { entry } = params;
  if (entry.expectsCompletionMessage !== true) {
    return false;
  }
  const payload = entry.pendingFinalDeliveryPayload;
  if (!payload) {
    return false;
  }
  if (
    !hasText(payload.requesterSessionKey) ||
    !hasText(payload.requesterDisplayKey) ||
    !hasText(payload.childSessionKey) ||
    !hasText(payload.childRunId) ||
    !hasText(payload.task)
  ) {
    return false;
  }
  const state = loadFinalDeliveryState(params);
  return state.kind === "pending" || state.kind === "retrying";
}

function lastErrorForState(state: FinalDeliveryState): FinalDeliveryError | undefined {
  if (state.kind === "pending" || state.kind === "retrying" || state.kind === "expired") {
    return state.lastError;
  }
  if (state.kind === "terminal_failed") {
    return state.error;
  }
  return undefined;
}

function attemptCountForState(state: FinalDeliveryState): number {
  if (state.kind === "pending" || state.kind === "retrying") {
    return state.attemptCount;
  }
  return 0;
}

function legacyFinalDeliveryError(entry: SubagentRunRecord): FinalDeliveryError | undefined {
  const message = (entry.pendingFinalDeliveryLastError ?? entry.lastAnnounceDeliveryError)?.trim();
  if (!message) {
    return undefined;
  }
  const retryable = entry.pendingFinalDeliveryLastRetryable ?? entry.lastAnnounceDeliveryRetryable;
  return {
    message,
    retryability: retryable === false ? "permanent" : retryable === true ? "transient" : "unknown",
    path: "none",
  };
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function clearPendingFinalDelivery(entry: SubagentRunRecord): void {
  entry.pendingFinalDelivery = undefined;
  entry.pendingFinalDeliveryCreatedAt = undefined;
  entry.pendingFinalDeliveryLastAttemptAt = undefined;
  entry.pendingFinalDeliveryAttemptCount = undefined;
  entry.pendingFinalDeliveryLastError = undefined;
  entry.pendingFinalDeliveryLastRetryable = undefined;
  entry.pendingFinalDeliveryPayload = undefined;
}
