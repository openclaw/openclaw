import type { SessionGoal } from "../../../config/sessions/types.js";
import type { AgentInternalEvent } from "../../internal-events.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "../registry/subagent-registry-read.js";
import { resolveDirectCompletionInjectionText } from "./subagent-announce-completion-delivery.js";

/** Transcript label for a child result held while the requester goal is paused. */
export const PAUSED_GOAL_CHILD_RESULT_LABEL = "Subagent result (goal paused)";

type ChildSpawnRecord = {
  createdAt: number;
  execution: { startedAt?: number };
} | null;

function completionSourceSessionKeys(params: {
  sourceSessionKey?: string;
  settleWakeSourceSessionKeys?: readonly string[];
}): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const key of [params.sourceSessionKey, ...(params.settleWakeSourceSessionKeys ?? [])]) {
    const trimmed = key?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    keys.push(trimmed);
  }
  return keys;
}

function recordedChildSpawnTimestamp(record: ChildSpawnRecord): number | undefined {
  if (!record) {
    return undefined;
  }
  const timestamps = [record.createdAt, record.execution.startedAt].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  return timestamps.length > 0 ? Math.min(...timestamps) : undefined;
}

function visiblePausedGoalText(params: {
  internalEvents?: readonly AgentInternalEvent[];
  pausedGoalVisibleText?: string;
  hasFailedTrustedSubagentCompletion: boolean;
  hasRequiredSubagentNoOutputCompletion: boolean;
}): string | undefined {
  // Completed event text wins. Settle findings supply text when those events
  // are absent. The failed notice is reserved for a failed or no-output child.
  const completed = resolveDirectCompletionInjectionText({
    events: params.internalEvents,
    contentKind: "completed_result",
  });
  if (completed) {
    return completed;
  }
  const visible = params.pausedGoalVisibleText?.trim();
  if (visible) {
    return visible;
  }
  if (params.hasFailedTrustedSubagentCompletion || params.hasRequiredSubagentNoOutputCompletion) {
    return resolveDirectCompletionInjectionText({
      events: params.internalEvents,
      contentKind: "failed_notice",
    });
  }
  return undefined;
}

/**
 * Visible child text to inject instead of starting a requester turn.
 * Undefined keeps the ordinary turn: the goal is not paused, the completion
 * is parent-only, a registry row is missing, a child spawned at or after the
 * pause, or a successful child has no visible text.
 */
export function resolvePausedGoalChildInjection(params: {
  completionTarget?: "parent";
  sourceSessionKey?: string;
  settleWakeSourceSessionKeys?: readonly string[];
  goal?: Pick<SessionGoal, "status" | "pausedAt">;
  internalEvents?: readonly AgentInternalEvent[];
  pausedGoalVisibleText?: string;
  hasFailedTrustedSubagentCompletion: boolean;
  hasRequiredSubagentNoOutputCompletion: boolean;
}): string | undefined {
  const pausedAt = params.goal?.status === "paused" ? params.goal.pausedAt : undefined;
  // Parent-only output must stay off the visible transcript. There is no hold
  // that keeps it private, so that completion stays on the requester turn.
  if (params.completionTarget === "parent" || typeof pausedAt !== "number") {
    return undefined;
  }
  const sessionKeys = completionSourceSessionKeys(params);
  if (sessionKeys.length === 0) {
    return undefined;
  }
  for (const sessionKey of sessionKeys) {
    const spawnedAt = recordedChildSpawnTimestamp(
      getLatestLiveSubagentRunByChildSessionKey(sessionKey),
    );
    if (spawnedAt === undefined || spawnedAt >= pausedAt) {
      return undefined;
    }
  }
  return visiblePausedGoalText(params);
}
