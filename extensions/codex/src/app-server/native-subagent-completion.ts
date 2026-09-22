// Reads terminal completion evidence without changing task or delivery ownership.
import {
  asFiniteNumber,
  normalizeOptionalString,
  readStringField as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexNativeSubagentCompletion } from "./native-subagent-notification.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

export type ChildAssistantMessages = {
  texts: Map<string, string>;
  order: string[];
  commentaryIds: Set<string>;
  finalMessageIds: Set<string>;
};

export type RecoveredCompletion = CodexNativeSubagentCompletion & {
  completedAt?: number;
};

type ChildCompletionState = {
  childThreadId: string;
  assistantMessagesByTurn: Map<string, ChildAssistantMessages>;
};

export function readThreadTurnRecovery(
  thread: JsonObject,
  childThreadId: string,
): { completion?: RecoveredCompletion; resumable: boolean } {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!isJsonObject(turn)) {
      continue;
    }
    const status = normalizeIdentifier(readString(turn, "status"));
    return {
      completion: readTurnCompletion(turn, childThreadId),
      resumable: status === "interrupted",
    };
  }
  return { resumable: false };
}

export function toChildTurnCompletion(
  childState: ChildCompletionState,
  turn: JsonObject,
): CodexNativeSubagentCompletion | undefined {
  const status = normalizeIdentifier(readString(turn, "status"));
  if (status === "completed") {
    const turnId = readString(turn, "id");
    const result = turnId ? lastChildAssistantMessage(childState, turnId) : undefined;
    return {
      childThreadId: childState.childThreadId,
      status: "succeeded",
      statusLabel: result ? "turn_completed" : "completed_without_final_message",
      result: result ?? "Subagent completed without a final assistant message.",
    };
  }
  if (status === "failed") {
    return {
      childThreadId: childState.childThreadId,
      status: "failed",
      statusLabel: "turn_failed",
      result: readTurnErrorMessage(turn) ?? "Subagent failed.",
    };
  }
  return undefined;
}

function lastChildAssistantMessage(
  childState: ChildCompletionState,
  turnId: string,
): string | undefined {
  const messages = childState.assistantMessagesByTurn.get(turnId);
  if (!messages) {
    return undefined;
  }
  for (const itemId of messages.order.toReversed()) {
    if (messages.finalMessageIds.has(itemId) && !messages.commentaryIds.has(itemId)) {
      const text = normalizeOptionalString(messages.texts.get(itemId));
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}

function readTurnErrorMessage(turn: JsonObject): string | undefined {
  const error = isJsonObject(turn.error) ? turn.error : undefined;
  return (
    normalizeOptionalString(readString(error, "message")) ??
    normalizeOptionalString(
      isJsonObject(error?.codexErrorInfo) ? readString(error.codexErrorInfo, "message") : undefined,
    )
  );
}

export function systemErrorFallbackCompletion(childThreadId: string): RecoveredCompletion {
  return {
    childThreadId,
    status: "failed",
    statusLabel: "system_error",
    result: "Subagent runtime reported a system error.",
  };
}

export function readTurnCompletion(
  turn: JsonObject,
  childThreadId: string,
): RecoveredCompletion | undefined {
  const status = normalizeIdentifier(readString(turn, "status"));
  if (status === "inprogress" || !status) {
    return undefined;
  }
  const result = readLastAgentMessage(turn);
  const completedAtSeconds = asFiniteNumber(turn.completedAt);
  const completedAt =
    completedAtSeconds === undefined ? undefined : Math.round(completedAtSeconds * 1_000);
  if (status === "completed") {
    return {
      childThreadId,
      status: "succeeded",
      statusLabel: result ? "task_complete" : "completed_without_final_message",
      result: result ?? "Subagent completed without a final assistant message.",
      completedAt,
    };
  }
  // Codex keeps interrupted subagents resumable. They remain a running task
  // until a later turn reaches an authoritative terminal state.
  if (status === "interrupted") {
    return undefined;
  }
  if (status === "failed") {
    return {
      childThreadId,
      status: "failed",
      statusLabel: "task_failed",
      result: readTurnErrorMessage(turn) ?? result ?? "Subagent failed.",
      completedAt,
    };
  }
  return undefined;
}

function readLastAgentMessage(turn: JsonObject): string | undefined {
  const items = Array.isArray(turn.items) ? turn.items : [];
  let legacyResult: string | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!isJsonObject(item)) {
      continue;
    }
    if (normalizeIdentifier(readString(item, "type")) !== "agentmessage") {
      continue;
    }
    const text = readString(item, "text")?.trim();
    if (!text) {
      continue;
    }
    const phase = normalizeIdentifier(readString(item, "phase"));
    if (phase === "finalanswer") {
      return text;
    }
    if (!phase) {
      legacyResult ??= text;
    }
  }
  return legacyResult;
}

export function normalizeIdentifier(value: string | undefined): string | undefined {
  return value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
}
