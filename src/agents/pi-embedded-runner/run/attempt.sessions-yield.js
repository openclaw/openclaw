import { log } from "../logger.js";
const SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE = "openclaw.sessions_yield_interrupt";
const SESSIONS_YIELD_CONTEXT_CUSTOM_TYPE = "openclaw.sessions_yield";
const SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS = process.env.OPENCLAW_TEST_FAST === "1" ? 250 : 2_000;
// Persist a hidden context reminder so the next turn knows why the runner stopped.
export function buildSessionsYieldContextMessage(message) {
    return `${message}\n\n[Context: The previous turn ended intentionally via sessions_yield while waiting for a follow-up event.]`;
}
export async function waitForSessionsYieldAbortSettle(params) {
    if (!params.settlePromise) {
        return;
    }
    let timeout;
    const outcome = await Promise.race([
        params.settlePromise
            .then(() => "settled")
            .catch((err) => {
            log.warn(`sessions_yield abort settle failed: runId=${params.runId} sessionId=${params.sessionId} err=${String(err)}`);
            return "errored";
        }),
        new Promise((resolve) => {
            timeout = setTimeout(() => resolve("timed_out"), SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS);
        }),
    ]);
    if (timeout) {
        clearTimeout(timeout);
    }
    if (outcome === "timed_out") {
        log.warn(`sessions_yield abort settle timed out: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS}`);
    }
}
// Return a synthetic aborted response so pi-agent-core unwinds without a real provider call.
export function createYieldAbortedResponse(model) {
    const message = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        stopReason: "aborted",
        api: model.api ?? "",
        provider: model.provider ?? "",
        model: model.id ?? "",
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
            },
        },
        timestamp: Date.now(),
    };
    return {
        async *[Symbol.asyncIterator]() { },
        result: async () => message,
    };
}
// Queue a hidden steering message so pi-agent-core injects it before the next
// LLM call once the current assistant turn finishes executing its tool calls.
export function queueSessionsYieldInterruptMessage(activeSession) {
    activeSession.agent.steer({
        role: "custom",
        customType: SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE,
        content: "[sessions_yield interrupt]",
        display: false,
        details: { source: "sessions_yield" },
        timestamp: Date.now(),
    });
}
// Append the caller-provided yield payload as a hidden session message once the run is idle.
export async function persistSessionsYieldContextMessage(activeSession, message) {
    await activeSession.sendCustomMessage({
        customType: SESSIONS_YIELD_CONTEXT_CUSTOM_TYPE,
        content: buildSessionsYieldContextMessage(message),
        display: false,
        details: { source: "sessions_yield", message },
    }, { triggerTurn: false });
}
// Remove the synthetic yield interrupt + aborted assistant entry from the live transcript.
export function stripSessionsYieldArtifacts(activeSession) {
    const strippedMessages = activeSession.messages.slice();
    while (strippedMessages.length > 0) {
        const last = strippedMessages.at(-1);
        if (last?.role === "assistant" && "stopReason" in last && last.stopReason === "aborted") {
            strippedMessages.pop();
            continue;
        }
        if (last?.role === "custom" &&
            "customType" in last &&
            last.customType === SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE) {
            strippedMessages.pop();
            continue;
        }
        break;
    }
    if (strippedMessages.length !== activeSession.messages.length) {
        activeSession.agent.state.messages = strippedMessages;
    }
    const sessionManager = activeSession.sessionManager;
    const fileEntries = sessionManager?.fileEntries;
    const byId = sessionManager?.byId;
    if (!fileEntries || !byId) {
        return;
    }
    let changed = false;
    while (fileEntries.length > 1) {
        const last = fileEntries.at(-1);
        if (!last || last.type === "session") {
            break;
        }
        const isYieldAbortAssistant = last.type === "message" &&
            last.message?.role === "assistant" &&
            last.message?.stopReason === "aborted";
        const isYieldInterruptMessage = last.type === "custom_message" && last.customType === SESSIONS_YIELD_INTERRUPT_CUSTOM_TYPE;
        if (!isYieldAbortAssistant && !isYieldInterruptMessage) {
            break;
        }
        fileEntries.pop();
        if (last.id) {
            byId.delete(last.id);
        }
        sessionManager.leafId = last.parentId ?? null;
        changed = true;
    }
    if (changed) {
        sessionManager._rewriteFile?.();
    }
}
