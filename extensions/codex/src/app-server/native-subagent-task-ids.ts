/**
 * Shared identifiers for representing Codex native subagents as OpenClaw task
 * runtime rows.
 */
import type { AgentHarnessTaskRecord } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import {
  normalizeOptionalString,
  readStringField as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { isJsonObject } from "./protocol.js";

export type NativeSubagentAssignment = {
  runId: string;
  childThreadId: string;
  nativeTurnId: string | undefined;
};

/** Task runtime namespace for Codex native subagent task rows. */
export const CODEX_NATIVE_SUBAGENT_RUNTIME = "subagent";
/** Task kind used to distinguish native Codex subagents from other subagent runtimes. */
export const CODEX_NATIVE_SUBAGENT_TASK_KIND = "codex-native";
/** Run id prefix for task rows keyed by Codex child thread ids. */
export const CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX = "codex-thread:";

/** Initial tasks keep their shipped locator; later assignments belong to a native turn. */
export function codexNativeSubagentRunId(threadId: string, turnId?: string): string {
  return `${CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX}${threadId.trim()}${turnId ? `:turn:${turnId}` : ""}`;
}

export function readCodexNativeSubagentRunId(
  runId: string | undefined,
): { threadId: string; turnId?: string } | undefined {
  if (!runId?.startsWith(CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX)) {
    return undefined;
  }
  const [threadId, turnId] = runId
    .slice(CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX.length)
    .split(":turn:");
  return threadId?.trim() ? { threadId, ...(turnId ? { turnId } : {}) } : undefined;
}

export function readNativeTaskAssignment(
  task: AgentHarnessTaskRecord,
): (NativeSubagentAssignment & { initialTurnId?: string }) | undefined {
  const runId = task.runId;
  const identity = readCodexNativeSubagentRunId(runId);
  if (!runId || !identity) {
    return undefined;
  }
  const storedTurnId = isJsonObject(task.detail)
    ? normalizeOptionalString(readString(task.detail, "nativeTurnId"))
    : undefined;
  return {
    runId,
    childThreadId: identity.threadId,
    nativeTurnId: storedTurnId ?? identity.turnId,
    initialTurnId: identity.turnId,
  };
}
export function readNativeSubagentThreadIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}
