import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { applyInputProvenanceToUserMessage, } from "../sessions/input-provenance.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
/**
 * Apply the tool-result guard to a SessionManager exactly once and expose
 * a flush method on the instance for easy teardown handling.
 */
export function guardSessionManager(sessionManager, opts) {
    if (typeof sessionManager.flushPendingToolResults === "function") {
        return sessionManager;
    }
    const hookRunner = getGlobalHookRunner();
    const beforeMessageWrite = hookRunner?.hasHooks("before_message_write")
        ? (event) => {
            return hookRunner.runBeforeMessageWrite(event, {
                agentId: opts?.agentId,
                sessionKey: opts?.sessionKey,
            });
        }
        : undefined;
    const transform = hookRunner?.hasHooks("tool_result_persist")
        ? // oxlint-disable-next-line typescript/no-explicit-any
            (message, meta) => {
                const out = hookRunner.runToolResultPersist({
                    toolName: meta.toolName,
                    toolCallId: meta.toolCallId,
                    message,
                    isSynthetic: meta.isSynthetic,
                }, {
                    agentId: opts?.agentId,
                    sessionKey: opts?.sessionKey,
                    toolName: meta.toolName,
                    toolCallId: meta.toolCallId,
                });
                return out?.message ?? message;
            }
        : undefined;
    const guard = installSessionToolResultGuard(sessionManager, {
        transformMessageForPersistence: (message) => applyInputProvenanceToUserMessage(message, opts?.inputProvenance),
        transformToolResultForPersistence: transform,
        allowSyntheticToolResults: opts?.allowSyntheticToolResults,
        allowedToolNames: opts?.allowedToolNames,
        beforeMessageWriteHook: beforeMessageWrite,
    });
    sessionManager.flushPendingToolResults = guard.flushPendingToolResults;
    return sessionManager;
}
