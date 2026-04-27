import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { applyInputProvenanceToUserMessage, } from "../sessions/input-provenance.js";
import { resolveLiveToolResultMaxChars } from "./pi-embedded-runner/tool-result-truncation.js";
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
        ? (message, meta) => {
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
        sessionKey: opts?.sessionKey,
        transformMessageForPersistence: (message) => applyInputProvenanceToUserMessage(message, opts?.inputProvenance),
        transformToolResultForPersistence: transform,
        allowSyntheticToolResults: opts?.allowSyntheticToolResults,
        missingToolResultText: opts?.missingToolResultText,
        allowedToolNames: opts?.allowedToolNames,
        beforeMessageWriteHook: beforeMessageWrite,
        maxToolResultChars: typeof opts?.contextWindowTokens === "number"
            ? resolveLiveToolResultMaxChars({
                contextWindowTokens: opts.contextWindowTokens,
                cfg: opts.config,
                agentId: opts.agentId,
            })
            : undefined,
    });
    sessionManager.flushPendingToolResults = guard.flushPendingToolResults;
    sessionManager.clearPendingToolResults = guard.clearPendingToolResults;
    return sessionManager;
}
