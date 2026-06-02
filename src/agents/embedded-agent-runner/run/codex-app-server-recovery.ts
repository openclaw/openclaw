import type { EmbeddedRunAttemptResult } from "./types.js";

/**
 * Decides whether a Codex app-server transport failure can be replayed once.
 * Recovery is restricted to early stdio failures with no assistant/tool/approval
 * side effects, so retrying cannot duplicate visible output or external work.
 */
export function resolveCodexAppServerRecoveryRetry(params: {
  attempt: EmbeddedRunAttemptResult;
  alreadyRetried: boolean;
}): { retry: boolean; reason?: string } {
  const failure = params.attempt.codexAppServerFailure;
  if (!failure) {
    return { retry: false, reason: "not_codex_app_server_failure" };
  }
  if (
    failure.kind !== "client_closed_before_turn_completed" &&
    failure.kind !== "turn_completion_idle_timeout"
  ) {
    return { retry: false, reason: failure.kind };
  }
  if (
    failure.kind === "turn_completion_idle_timeout" &&
    failure.turnWatchTimeoutKind !== "completion"
  ) {
    return { retry: false, reason: failure.turnWatchTimeoutKind ?? "unknown_turn_watch_timeout" };
  }
  if (failure.transport !== "stdio") {
    return { retry: false, reason: "non_stdio_transport" };
  }
  if (params.alreadyRetried) {
    return { retry: false, reason: "retry_exhausted" };
  }
  // Replay safety must agree at the transport-failure layer and at the
  // attempt metadata layer; either side can observe non-replayable activity.
  if (!failure.replaySafe || !params.attempt.replayMetadata.replaySafe) {
    return { retry: false, reason: failure.replayBlockedReason ?? "replay_unsafe" };
  }
  if (params.attempt.assistantTexts.some((text) => text.trim().length > 0)) {
    return { retry: false, reason: "assistant_output" };
  }
  // Tool or approval activity may have had external effects, so app-server
  // recovery cannot silently replay even when the transport failure looks early.
  if (
    params.attempt.toolMetas.length > 0 ||
    params.attempt.clientToolCalls ||
    params.attempt.lastToolError ||
    params.attempt.didSendDeterministicApprovalPrompt
  ) {
    return { retry: false, reason: "tool_activity" };
  }
  if (
    params.attempt.itemLifecycle.startedCount > 0 ||
    params.attempt.itemLifecycle.activeCount > 0
  ) {
    return { retry: false, reason: "active_item" };
  }
  return { retry: true };
}

/** Backward-compatible alias for the original client-close-only helper name. */
export const resolveCodexAppServerClientCloseRetry = resolveCodexAppServerRecoveryRetry;
