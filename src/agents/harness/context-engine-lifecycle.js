import { runContextEngineMaintenance } from "../pi-embedded-runner/context-engine-maintenance.js";
import { buildAfterTurnRuntimeContext, buildAfterTurnRuntimeContextFromUsage, } from "../pi-embedded-runner/run/attempt.prompt-helpers.js";
/**
 * Run optional bootstrap + bootstrap maintenance for a harness-owned context engine.
 */
export async function bootstrapHarnessContextEngine(params) {
    if (!params.hadSessionFile ||
        !(params.contextEngine?.bootstrap || params.contextEngine?.maintain)) {
        return;
    }
    try {
        if (typeof params.contextEngine?.bootstrap === "function") {
            await params.contextEngine.bootstrap({
                sessionId: params.sessionId,
                sessionKey: params.sessionKey,
                sessionFile: params.sessionFile,
            });
        }
        await (params.runMaintenance ?? runHarnessContextEngineMaintenance)({
            contextEngine: params.contextEngine,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            sessionFile: params.sessionFile,
            reason: "bootstrap",
            sessionManager: params.sessionManager,
            runtimeContext: params.runtimeContext,
        });
    }
    catch (bootstrapErr) {
        params.warn(`context engine bootstrap failed: ${String(bootstrapErr)}`);
    }
}
/**
 * Assemble model context through the active harness-owned context engine.
 */
export async function assembleHarnessContextEngine(params) {
    if (!params.contextEngine) {
        return undefined;
    }
    return await params.contextEngine.assemble({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        messages: params.messages,
        tokenBudget: params.tokenBudget,
        ...(params.availableTools ? { availableTools: params.availableTools } : {}),
        ...(params.citationsMode ? { citationsMode: params.citationsMode } : {}),
        model: params.modelId,
        ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
    });
}
/**
 * Finalize a completed harness turn via afterTurn or ingest fallbacks.
 */
export async function finalizeHarnessContextEngineTurn(params) {
    if (!params.contextEngine) {
        return { postTurnFinalizationSucceeded: true };
    }
    let postTurnFinalizationSucceeded = true;
    if (typeof params.contextEngine.afterTurn === "function") {
        try {
            await params.contextEngine.afterTurn({
                sessionId: params.sessionIdUsed,
                sessionKey: params.sessionKey,
                sessionFile: params.sessionFile,
                messages: params.messagesSnapshot,
                prePromptMessageCount: params.prePromptMessageCount,
                tokenBudget: params.tokenBudget,
                runtimeContext: params.runtimeContext,
            });
        }
        catch (afterTurnErr) {
            postTurnFinalizationSucceeded = false;
            params.warn(`context engine afterTurn failed: ${String(afterTurnErr)}`);
        }
    }
    else {
        const newMessages = params.messagesSnapshot.slice(params.prePromptMessageCount);
        if (newMessages.length > 0) {
            if (typeof params.contextEngine.ingestBatch === "function") {
                try {
                    await params.contextEngine.ingestBatch({
                        sessionId: params.sessionIdUsed,
                        sessionKey: params.sessionKey,
                        messages: newMessages,
                    });
                }
                catch (ingestErr) {
                    postTurnFinalizationSucceeded = false;
                    params.warn(`context engine ingest failed: ${String(ingestErr)}`);
                }
            }
            else {
                for (const msg of newMessages) {
                    try {
                        await params.contextEngine.ingest?.({
                            sessionId: params.sessionIdUsed,
                            sessionKey: params.sessionKey,
                            message: msg,
                        });
                    }
                    catch (ingestErr) {
                        postTurnFinalizationSucceeded = false;
                        params.warn(`context engine ingest failed: ${String(ingestErr)}`);
                    }
                }
            }
        }
    }
    if (!params.promptError &&
        !params.aborted &&
        !params.yieldAborted &&
        postTurnFinalizationSucceeded) {
        await (params.runMaintenance ?? runHarnessContextEngineMaintenance)({
            contextEngine: params.contextEngine,
            sessionId: params.sessionIdUsed,
            sessionKey: params.sessionKey,
            sessionFile: params.sessionFile,
            reason: "turn",
            sessionManager: params.sessionManager,
            runtimeContext: params.runtimeContext,
        });
    }
    return { postTurnFinalizationSucceeded };
}
/**
 * Build runtime context passed into harness context-engine hooks.
 */
export function buildHarnessContextEngineRuntimeContext(params) {
    return buildAfterTurnRuntimeContext(params);
}
/**
 * Build runtime context passed into harness context-engine hooks from usage data.
 */
export function buildHarnessContextEngineRuntimeContextFromUsage(params) {
    return buildAfterTurnRuntimeContextFromUsage(params);
}
/**
 * Run optional transcript maintenance for a harness-owned context engine.
 */
export async function runHarnessContextEngineMaintenance(params) {
    return await runContextEngineMaintenance({
        contextEngine: params.contextEngine,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
        reason: params.reason,
        sessionManager: params.sessionManager,
        runtimeContext: params.runtimeContext,
        executionMode: params.executionMode,
    });
}
/**
 * Return true when a non-legacy context engine should affect plugin harness behavior.
 */
export function isActiveHarnessContextEngine(contextEngine) {
    return Boolean(contextEngine && contextEngine.info.id !== "legacy");
}
