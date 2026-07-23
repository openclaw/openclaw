import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { CodexNativePreToolUseFailure } from "./native-hook-relay.js";

const CODEX_RUN_TOOL_CALL_WARNING_THRESHOLD = 25;
const CODEX_RUN_TOOL_CALL_HARD_LIMIT = 50;
const CODEX_RUN_IDENTICAL_FAILURE_LIMIT = 2;

const CODEX_RUN_SAFETY_PREVIEW_CHARS = 500;

type CodexRunSafetyToolAttempt = {
  toolName: string;
  toolCallId?: string;
  arguments?: unknown;
};

type CodexRunSafetyTrip = {
  kind: "identical_failure" | "tool_call_limit";
  attempts: number;
  toolCallCount: number;
  toolName?: string;
  error: string;
  lastSuccessfulStep?: string;
  currentState: string;
  possiblePartialWrites: string;
  likelyCause: string;
  recommendedRecovery: string;
  decisionNeeded: string;
};

type CodexRunSafetyCheckpoint = {
  toolCallCount: number;
  lastSuccessfulStep?: string;
};

type CodexRunSafetyController = {
  recordToolCall: (attempt: CodexRunSafetyToolAttempt) => boolean;
  recordToolOutcome: (
    attempt: CodexRunSafetyToolAttempt & { success: boolean; error?: string },
  ) => void;
  recordNativePreToolUseFailure: (failure: CodexNativePreToolUseFailure) => void;
  readTrip: () => CodexRunSafetyTrip | undefined;
};

export function createCodexRunSafetyController(params: {
  onWarning: (checkpoint: CodexRunSafetyCheckpoint) => void;
  onTrip: (trip: CodexRunSafetyTrip) => void;
  warningThreshold?: number;
  hardLimit?: number;
  identicalFailureLimit?: number;
}): CodexRunSafetyController {
  const warningThreshold = params.warningThreshold ?? CODEX_RUN_TOOL_CALL_WARNING_THRESHOLD;
  const hardLimit = params.hardLimit ?? CODEX_RUN_TOOL_CALL_HARD_LIMIT;
  const identicalFailureLimit = params.identicalFailureLimit ?? CODEX_RUN_IDENTICAL_FAILURE_LIMIT;
  const observedToolCallIds = new Set<string>();
  const observedToolOutcomeIds = new Set<string>();
  const failureCounts = new Map<string, number>();
  const failureKeysByOperation = new Map<string, Set<string>>();
  let anonymousToolCallCount = 0;
  let toolCallCount = 0;
  let warned = false;
  let trip: CodexRunSafetyTrip | undefined;
  let lastSuccessfulStep: string | undefined;

  const tripOnce = (nextTrip: CodexRunSafetyTrip) => {
    if (trip) {
      return;
    }
    trip = nextTrip;
    params.onTrip(nextTrip);
  };

  const recordToolCall: CodexRunSafetyController["recordToolCall"] = (attempt) => {
    if (trip) {
      return false;
    }
    const identity = attempt.toolCallId ?? `anonymous:${++anonymousToolCallCount}`;
    if (observedToolCallIds.has(identity)) {
      return true;
    }
    observedToolCallIds.add(identity);
    toolCallCount += 1;
    if (!warned && toolCallCount >= warningThreshold) {
      warned = true;
      params.onWarning({ toolCallCount, lastSuccessfulStep });
    }
    if (toolCallCount >= hardLimit) {
      tripOnce({
        kind: "tool_call_limit",
        attempts: toolCallCount,
        toolCallCount,
        toolName: safePreview(attempt.toolName),
        error: `hard tool-call limit reached (${hardLimit})`,
        lastSuccessfulStep,
        currentState: "the turn was interrupted before another tool could run",
        possiblePartialWrites:
          "Earlier tool calls remain committed; the blocked call was not executed by OpenClaw",
        likelyCause: "the turn reached its configured tool-call safety ceiling",
        recommendedRecovery:
          "review the completed work and start a new bounded turn only if more tool calls are required",
        decisionNeeded: "explicitly continue from the checkpoint or choose a narrower next step",
      });
    }
    return !trip;
  };

  const recordToolOutcome: CodexRunSafetyController["recordToolOutcome"] = (attempt) => {
    if (trip) {
      return;
    }
    recordToolCall(attempt);
    if (trip) {
      return;
    }
    const outcomeIdentity = attempt.toolCallId ?? `anonymous-outcome:${++anonymousToolCallCount}`;
    if (observedToolOutcomeIds.has(outcomeIdentity)) {
      return;
    }
    observedToolOutcomeIds.add(outcomeIdentity);
    const operationKey = buildOperationKey(attempt);
    if (attempt.success) {
      lastSuccessfulStep = safePreview(attempt.toolName);
      for (const failureKey of failureKeysByOperation.get(operationKey) ?? []) {
        failureCounts.delete(failureKey);
      }
      failureKeysByOperation.delete(operationKey);
      return;
    }
    const rawError = attempt.error?.trim() || "tool call failed";
    const failureKey = `${operationKey}\u0000${normalizeMaterialValue(rawError)}`;
    const attempts = (failureCounts.get(failureKey) ?? 0) + 1;
    failureCounts.set(failureKey, attempts);
    const operationFailureKeys = failureKeysByOperation.get(operationKey) ?? new Set<string>();
    operationFailureKeys.add(failureKey);
    failureKeysByOperation.set(operationKey, operationFailureKeys);
    if (attempts >= identicalFailureLimit) {
      tripOnce({
        kind: "identical_failure",
        attempts,
        toolCallCount,
        toolName: safePreview(attempt.toolName),
        error: safePreview(rawError),
        lastSuccessfulStep,
        currentState: "the turn was interrupted after the repeated failure",
        possiblePartialWrites:
          "The failed operation may have partially written state; completed earlier calls were not rolled back",
        likelyCause:
          "the same tool, materially equivalent arguments, and materially equivalent error repeated without a successful matching operation",
        recommendedRecovery:
          "verify the failed dependency and current external state before choosing a different operation",
        decisionNeeded:
          "restore the dependency, provide missing access or information, or explicitly choose another recovery path",
      });
    }
  };

  return {
    recordToolCall,
    recordToolOutcome,
    recordNativePreToolUseFailure(failure) {
      recordToolOutcome({
        toolName: failure.toolName,
        toolCallId: failure.toolCallId,
        success: false,
        error: failure.disposition,
      });
    },
    readTrip: () => trip,
  };
}

export function formatCodexRunSafetyAlert(params: {
  objective: string;
  trip: CodexRunSafetyTrip;
}): string {
  const { trip } = params;
  return [
    "OpenClaw stopped this turn to prevent a runaway tool loop.",
    `Objective: ${params.objective}`,
    `Failed operation: ${trip.toolName ?? "next tool call"}`,
    `Error: ${trip.error}`,
    `Attempts: ${trip.attempts}`,
    `Total tool calls: ${trip.toolCallCount}`,
    `Last successful step: ${trip.lastSuccessfulStep ?? "none recorded"}`,
    `Current state: ${trip.currentState}`,
    `Possible partial writes or duplicates: ${trip.possiblePartialWrites}`,
    `Likely cause: ${trip.likelyCause}`,
    `Recommended recovery: ${trip.recommendedRecovery}`,
    `Needed from you: ${trip.decisionNeeded}`,
  ].join("\n");
}

export function formatCodexRunSafetyCheckpoint(checkpoint: CodexRunSafetyCheckpoint): string {
  return [
    `OpenClaw checkpoint: this turn has used ${checkpoint.toolCallCount} tool calls.`,
    `Last successful step: ${checkpoint.lastSuccessfulStep ?? "none recorded"}.`,
    `The turn will stop at ${CODEX_RUN_TOOL_CALL_HARD_LIMIT}; checkpoint progress before continuing.`,
  ].join("\n");
}

function buildOperationKey(attempt: CodexRunSafetyToolAttempt): string {
  return [
    normalizeMaterialValue(attempt.toolName),
    normalizeMaterialValue(attempt.arguments ?? null),
  ].join("\u0000");
}

function normalizeMaterialValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim().toLowerCase().replace(/\s+/gu, " ");
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value.map((entry) => normalizeMaterialJson(entry)));
  }
  if (value && typeof value === "object") {
    return JSON.stringify(normalizeMaterialJson(value));
  }
  return JSON.stringify(value);
}

function normalizeMaterialJson(value: unknown): unknown {
  if (typeof value === "string") {
    return value.trim().toLowerCase().replace(/\s+/gu, " ");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeMaterialJson(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeMaterialJson(entry)]),
  );
}

function safePreview(value: string): string {
  return truncateUtf16Safe(
    redactSensitiveText(value).replace(/\s+/gu, " ").trim(),
    CODEX_RUN_SAFETY_PREVIEW_CHARS,
  );
}
