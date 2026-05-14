/**
 * Consecutive Tool Error Circuit Breaker
 *
 * Detects and aborts agent runs that are stuck in a repeated-tool-error loop.
 * This covers cases that the registered-tool loop detector cannot reach, most
 * notably "Tool X not found" errors that are generated in pi-agent-core's
 * prepareToolCall() BEFORE beforeToolCall hooks are invoked.
 *
 * Two patterns are detected:
 *   1. sameToolError  — same (toolName + errorText) N times consecutively.
 *   2. errorFlood     — any M consecutive tool errors of any kind.
 *
 * On trigger the guard calls onAbort(), emits a DiagnosticToolLoopEvent, and
 * throws so that the transformContext chain unwinds the agent prompt call.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { emitDiagnosticEvent } from "../../../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("agent/consecutive-error-guard");

/** Default: abort after same (toolName, errorText) repeated this many times in a row. */
const DEFAULT_SAME_TOOL_ERROR_THRESHOLD = 3;

/** Default: abort after this many consecutive tool errors of any kind. */
const DEFAULT_ERROR_FLOOD_THRESHOLD = 10;

export const CONSECUTIVE_TOOL_ERROR_ABORT_MESSAGE =
  "Agent loop aborted: repeated tool errors detected (consecutive-error circuit breaker).";

// ── Internal types ────────────────────────────────────────────────────────────

type GuardableTransformContext = (
  messages: AgentMessage[],
  signal: AbortSignal,
) => AgentMessage[] | Promise<AgentMessage[]>;

type GuardableAgent = object;

type GuardableAgentRecord = {
  transformContext?: GuardableTransformContext;
};

type ToolErrorRecord = {
  toolName: string;
  errorText: string;
};

// ── Message inspection ────────────────────────────────────────────────────────

/** Extract error info from a tool result message, or return null if not an error. */
function getToolError(message: AgentMessage): ToolErrorRecord | null {
  const msg = message as Record<string, unknown>;
  // pi-agent-core emits toolResult messages with role "toolResult"
  if (msg.role !== "toolResult" && msg.role !== "tool") {
    return null;
  }
  if (!msg.isError) {
    return null;
  }

  const toolName = typeof msg.toolName === "string" ? msg.toolName : "unknown";

  const content = msg.content;
  let errorText = "";
  if (Array.isArray(content)) {
    errorText = content
      .filter(
        (c): c is { type: string; text: string } =>
          !!c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string",
      )
      .map((c) => c.text)
      .join(" ")
      .trim();
  } else if (typeof content === "string") {
    errorText = content.trim();
  }

  return { toolName, errorText };
}

/**
 * Walk the tail of the messages array and collect consecutive tool error records.
 * Stops at the first non-error message (scanning newest → oldest).
 */
function collectTailErrors(messages: AgentMessage[]): ToolErrorRecord[] {
  const tail: ToolErrorRecord[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const err = getToolError(messages[i]);
    if (!err) {
      break;
    }
    tail.unshift(err); // maintain chronological order
  }
  return tail;
}

// ── Public API ────────────────────────────────────────────────────────────────

export type ConsecutiveErrorGuardParams = {
  /** The agent object whose transformContext will be wrapped. */
  agent: GuardableAgent;
  /** Called when the circuit breaker fires; should abort the run (e.g. runAbortController.abort). */
  onAbort: (reason: string) => void;
  /** Session key for diagnostic events and log context. */
  sessionKey?: string;
  /** Trigger label (e.g. "memory", "task") for log context. */
  trigger?: string;
  /**
   * Abort after the same (toolName + errorText) appears this many times consecutively.
   * @default 3
   */
  sameToolErrorThreshold?: number;
  /**
   * Abort after this many consecutive tool errors of any kind.
   * @default 10
   */
  errorFloodThreshold?: number;
};

/**
 * Install a consecutive-error circuit breaker on the agent's transformContext.
 * Returns a cleanup function that restores the original transformContext.
 */
export function installConsecutiveErrorGuard(params: ConsecutiveErrorGuardParams): () => void {
  const sameToolErrorThreshold = params.sameToolErrorThreshold ?? DEFAULT_SAME_TOOL_ERROR_THRESHOLD;
  const errorFloodThreshold = params.errorFloodThreshold ?? DEFAULT_ERROR_FLOOD_THRESHOLD;

  const mutableAgent = params.agent as GuardableAgentRecord;
  const originalTransformContext = mutableAgent.transformContext;

  mutableAgent.transformContext = (async (messages: AgentMessage[], signal: AbortSignal) => {
    // Run upstream transforms first (e.g. tool-result-context-guard truncation).
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;
    const msgs = Array.isArray(transformed) ? transformed : messages;

    const tailErrors = collectTailErrors(msgs);
    const consecutiveErrors = tailErrors.length;
    if (consecutiveErrors === 0) {
      return msgs;
    }

    // ── Check same-tool-error streak ─────────────────────────────────────────
    // Count how many of the most-recent consecutive errors share the same key.
    const latest = tailErrors[tailErrors.length - 1];
    let sameKeyStreak = 0;
    for (let i = tailErrors.length - 1; i >= 0; i--) {
      if (
        tailErrors[i].toolName === latest.toolName &&
        tailErrors[i].errorText === latest.errorText
      ) {
        sameKeyStreak++;
      } else {
        break;
      }
    }

    if (sameKeyStreak >= sameToolErrorThreshold) {
      const message =
        `Consecutive tool error circuit breaker (same-tool): ` +
        `tool="${latest.toolName}" error="${latest.errorText}" ` +
        `repeated ${sameKeyStreak} times in a row ` +
        `(threshold=${sameToolErrorThreshold}, session=${params.sessionKey ?? "unknown"}).`;
      log.error(message);
      emitDiagnosticEvent({
        type: "tool.loop",
        sessionKey: params.sessionKey,
        toolName: latest.toolName,
        level: "critical",
        action: "block",
        detector: "consecutive_tool_error",
        count: sameKeyStreak,
        message,
      });
      params.onAbort(CONSECUTIVE_TOOL_ERROR_ABORT_MESSAGE);
      throw new Error(CONSECUTIVE_TOOL_ERROR_ABORT_MESSAGE);
    }

    // ── Check error-flood threshold ───────────────────────────────────────────
    if (consecutiveErrors >= errorFloodThreshold) {
      const floodTool = latest.toolName;
      const message =
        `Consecutive tool error circuit breaker (flood): ` +
        `${consecutiveErrors} consecutive tool errors detected ` +
        `(threshold=${errorFloodThreshold}, session=${params.sessionKey ?? "unknown"}).`;
      log.error(message);
      emitDiagnosticEvent({
        type: "tool.loop",
        sessionKey: params.sessionKey,
        toolName: floodTool,
        level: "critical",
        action: "block",
        detector: "consecutive_tool_error",
        count: consecutiveErrors,
        message,
      });
      params.onAbort(CONSECUTIVE_TOOL_ERROR_ABORT_MESSAGE);
      throw new Error(CONSECUTIVE_TOOL_ERROR_ABORT_MESSAGE);
    }

    return msgs;
  }) as GuardableTransformContext;

  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}
