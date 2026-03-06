import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { logError } from "../logger.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  applyInputProvenanceToUserMessage,
  type InputProvenance,
} from "../sessions/input-provenance.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

export type GuardedSessionManager = SessionManager & {
  /** Flush any synthetic tool results for pending tool calls. Idempotent. */
  flushPendingToolResults?: () => void;
  /** Set of tool names that were registered at guard time (read-only snapshot). */
  readonly knownToolNames?: ReadonlySet<string>;
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

  // Snapshot tool names at guard time so downstream code can detect if a tool
  // was registered but later lost at runtime (#27205).
  const knownToolNames: Set<string> = new Set<string>();
  if (opts?.allowedToolNames) {
    for (const name of opts.allowedToolNames) {
      if (typeof name === "string" && name.trim()) {
        knownToolNames.add(name.trim());
      }
    }
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
  const guarded = sessionManager as GuardedSessionManager;
  guarded.flushPendingToolResults = guard.flushPendingToolResults;
  Object.defineProperty(guarded, "knownToolNames", {
    value: Object.freeze(knownToolNames),
    writable: false,
    configurable: false,
  });
  return guarded;
}

/**
 * Log a critical warning when a tool that was registered at session start
 * can no longer be found at runtime — strong indicator of #27205 cascade.
 */
export function warnToolRegistryCorruption(toolName: string, sessionKey?: string): void {
  logError(
    `[CRITICAL] Tool '${toolName}' was registered but lost at runtime` +
      `${sessionKey ? ` (session=${sessionKey})` : ""} — possible tool registry corruption (#27205)`,
  );
}
