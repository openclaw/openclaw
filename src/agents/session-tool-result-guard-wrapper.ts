import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  applyInputProvenanceToUserMessage,
  type InputProvenance,
} from "../sessions/input-provenance.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { validateAndSanitizeToolResult } from "./session-tool-result-validation.js";

export type GuardedSessionManager = SessionManager & {
  /** Flush any synthetic tool results for pending tool calls. Idempotent. */
  flushPendingToolResults?: () => void;
};

/**
 * Apply the tool-result guard to a SessionManager exactly once and expose
 * a flush method on the instance for easy teardown handling.
 *
 * Includes pre-persist validation to handle corrupted tool responses:
 * - Validates JSON structure before storing
 * - Validates UTF-8 encoding
 * - Sanitizes and stores placeholder if validation fails
 * - Logs original to debug file for investigation
 */
export function guardSessionManager(
  sessionManager: SessionManager,
  opts?: {
    agentId?: string;
    sessionKey?: string;
    inputProvenance?: InputProvenance;
    allowSyntheticToolResults?: boolean;
    warn?: (message: string) => void;
  },
): GuardedSessionManager {
  if (typeof (sessionManager as GuardedSessionManager).flushPendingToolResults === "function") {
    return sessionManager as GuardedSessionManager;
  }

  const hookRunner = getGlobalHookRunner();

  // Combined transform: validate -> plugin hooks -> validate again
  const transform = hookRunner?.hasHooks("tool_result_persist")
    ? // oxlint-disable-next-line typescript/no-explicit-any
      (message: any, meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean }) => {
        // Step 1: Pre-validate the incoming message
        const preValidation = validateAndSanitizeToolResult(message, {
          toolCallId: meta.toolCallId,
          toolName: meta.toolName,
          sessionKey: opts?.sessionKey,
          warn: opts?.warn,
        });

        let currentMessage = preValidation.message;

        // Step 2: Run plugin hooks
        const out = hookRunner.runToolResultPersist(
          {
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
            message: currentMessage,
            isSynthetic: meta.isSynthetic,
          },
          {
            agentId: opts?.agentId,
            sessionKey: opts?.sessionKey,
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
          },
        );
        currentMessage = out?.message ?? currentMessage;

        // Step 3: Post-validate after plugin transformations
        const postValidation = validateAndSanitizeToolResult(currentMessage, {
          toolCallId: meta.toolCallId,
          toolName: meta.toolName,
          sessionKey: opts?.sessionKey,
          warn: opts?.warn,
        });

        return postValidation.message;
      }
    : // No plugin hooks — just validate
      // oxlint-disable-next-line typescript/no-explicit-any
      (message: any, meta: { toolCallId?: string; toolName?: string }) => {
        const validation = validateAndSanitizeToolResult(message, {
          toolCallId: meta.toolCallId,
          toolName: meta.toolName,
          sessionKey: opts?.sessionKey,
          warn: opts?.warn,
        });
        return validation.message;
      };

  const guard = installSessionToolResultGuard(sessionManager, {
    transformMessageForPersistence: (message) =>
      applyInputProvenanceToUserMessage(message, opts?.inputProvenance),
    transformToolResultForPersistence: transform,
    allowSyntheticToolResults: opts?.allowSyntheticToolResults,
  });
  (sessionManager as GuardedSessionManager).flushPendingToolResults = guard.flushPendingToolResults;
  return sessionManager as GuardedSessionManager;
}
