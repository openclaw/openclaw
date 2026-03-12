import type { SessionManager } from "@mariozechner/pi-coding-agent";
import {
  scheduleSessionManagerSyncToPostgres,
  scheduleSessionManagerTailSyncToPostgres,
} from "../persistence/service.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  applyInputProvenanceToUserMessage,
  type InputProvenance,
} from "../sessions/input-provenance.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

const TRANSCRIPT_MUTATOR_NAMES = [
  "appendCustomMessageEntry",
  "appendCompaction",
  "appendCustomEntry",
  "appendLabelChange",
  "appendMessage",
  "appendModelChange",
  "appendSessionInfo",
  "appendThinkingLevelChange",
  "branchWithSummary",
] as const;

export type GuardedSessionManager = SessionManager & {
  /** Flush any synthetic tool results for pending tool calls. Idempotent. */
  flushPendingToolResults?: () => void;
  /** Clear pending tool calls without persisting synthetic tool results. Idempotent. */
  clearPendingToolResults?: () => void;
};

/**
 * Apply the tool-result guard to a SessionManager exactly once and expose
 * a flush method on the instance for easy teardown handling.
 */
export function guardSessionManager(
  sessionManager: SessionManager,
  opts?: {
    agentId?: string;
    sessionKey?: string;
    inputProvenance?: InputProvenance;
    allowSyntheticToolResults?: boolean;
    allowedToolNames?: Iterable<string>;
  },
): GuardedSessionManager {
  if (typeof (sessionManager as GuardedSessionManager).flushPendingToolResults === "function") {
    return sessionManager as GuardedSessionManager;
  }

  const hookRunner = getGlobalHookRunner();
  const beforeMessageWrite = hookRunner?.hasHooks("before_message_write")
    ? (event: { message: import("@mariozechner/pi-agent-core").AgentMessage }) => {
        return hookRunner.runBeforeMessageWrite(event, {
          agentId: opts?.agentId,
          sessionKey: opts?.sessionKey,
        });
      }
    : undefined;

  const transform = hookRunner?.hasHooks("tool_result_persist")
    ? // oxlint-disable-next-line typescript/no-explicit-any
      (message: any, meta: { toolCallId?: string; toolName?: string; isSynthetic?: boolean }) => {
        const out = hookRunner.runToolResultPersist(
          {
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
            message,
            isSynthetic: meta.isSynthetic,
          },
          {
            agentId: opts?.agentId,
            sessionKey: opts?.sessionKey,
            toolName: meta.toolName,
            toolCallId: meta.toolCallId,
          },
        );
        return out?.message ?? message;
      }
    : undefined;

  const guard = installSessionToolResultGuard(sessionManager, {
    transformMessageForPersistence: (message) =>
      applyInputProvenanceToUserMessage(message, opts?.inputProvenance),
    transformToolResultForPersistence: transform,
    allowSyntheticToolResults: opts?.allowSyntheticToolResults,
    allowedToolNames: opts?.allowedToolNames,
    beforeMessageWriteHook: beforeMessageWrite,
  });
  (sessionManager as GuardedSessionManager).flushPendingToolResults = guard.flushPendingToolResults;
  (sessionManager as GuardedSessionManager).clearPendingToolResults = guard.clearPendingToolResults;
  installTranscriptPersistenceMirror(sessionManager, opts?.agentId);
  return sessionManager as GuardedSessionManager;
}

function installTranscriptPersistenceMirror(
  sessionManager: SessionManager,
  agentId?: string,
): void {
  const guarded = sessionManager as SessionManager & {
    __openclawTranscriptPersistenceWrapped?: boolean;
    getSessionFile?: () => string;
  };
  if (guarded.__openclawTranscriptPersistenceWrapped) {
    return;
  }
  const sessionFile =
    typeof guarded.getSessionFile === "function" ? guarded.getSessionFile() : undefined;
  if (!sessionFile) {
    return;
  }

  scheduleSessionManagerSyncToPostgres({
    sessionManager,
    transcriptPath: sessionFile,
    agentId,
  });

  for (const methodName of TRANSCRIPT_MUTATOR_NAMES) {
    const sessionManagerRecord = sessionManager as unknown as Record<string, unknown>;
    const original = sessionManagerRecord[methodName];
    if (typeof original !== "function") {
      continue;
    }
    sessionManagerRecord[methodName] = (...args: unknown[]) => {
      const result = (original as (...innerArgs: unknown[]) => unknown).apply(sessionManager, args);
      scheduleSessionManagerTailSyncToPostgres({
        sessionManager,
        transcriptPath: sessionFile,
        agentId,
      });
      return result;
    };
  }

  guarded.__openclawTranscriptPersistenceWrapped = true;
}
