import fs from "node:fs/promises";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { normalizeReplyPayload } from "../../auto-reply/reply/normalize-reply.js";
import { resolveSessionTranscriptFile } from "../../config/sessions/transcript.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { sanitizeForLog } from "../../terminal/ansi.js";
import { resolveBootstrapWarningSignaturesSeen } from "../bootstrap-budget.js";
import { runCliAgent } from "../cli-runner.js";
import { getCliSessionBinding, setCliSessionBinding } from "../cli-session.js";
import { FailoverError } from "../failover-error.js";
import { resolveAgentHarnessPolicy } from "../harness/selection.js";
import { isCliProvider } from "../model-selection.js";
import { prepareSessionManagerForRun } from "../pi-embedded-runner/session-manager-init.js";
import { runEmbeddedPiAgent } from "../pi-embedded.js";
import { buildAgentRuntimeAuthPlan } from "../runtime-plan/auth.js";
import { buildUsageWithNoCost } from "../stream-message-shared.js";
import { claudeCliSessionTranscriptHasContent, resolveFallbackRetryPrompt, } from "./attempt-execution.helpers.js";
import { persistSessionEntry } from "./attempt-execution.shared.js";
import { clearCliSessionInStore } from "./session-store.js";
export { claudeCliSessionTranscriptHasContent, createAcpVisibleTextAccumulator, resolveFallbackRetryPrompt, sessionFileHasContent, } from "./attempt-execution.helpers.js";
const log = createSubsystemLogger("agents/agent-command");
const ACP_TRANSCRIPT_USAGE = {
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
};
function resolveTranscriptUsage(usage) {
    if (!usage) {
        return ACP_TRANSCRIPT_USAGE;
    }
    return buildUsageWithNoCost({
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.total,
    });
}
async function persistTextTurnTranscript(params) {
    const promptText = params.transcriptBody ?? params.body;
    const replyText = params.finalText;
    if (!promptText && !replyText) {
        return params.sessionEntry;
    }
    const { sessionFile, sessionEntry } = await resolveSessionTranscriptFile({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionEntry: params.sessionEntry,
        sessionStore: params.sessionStore,
        storePath: params.storePath,
        agentId: params.sessionAgentId,
        threadId: params.threadId,
    });
    const hadSessionFile = await fs
        .access(sessionFile)
        .then(() => true)
        .catch(() => false);
    const sessionManager = SessionManager.open(sessionFile);
    await prepareSessionManagerForRun({
        sessionManager,
        sessionFile,
        hadSessionFile,
        sessionId: params.sessionId,
        cwd: params.sessionCwd,
    });
    if (promptText) {
        sessionManager.appendMessage({
            role: "user",
            content: promptText,
            timestamp: Date.now(),
        });
    }
    if (replyText) {
        sessionManager.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: replyText }],
            api: params.assistant.api,
            provider: params.assistant.provider,
            model: params.assistant.model,
            usage: resolveTranscriptUsage(params.assistant.usage),
            stopReason: "stop",
            timestamp: Date.now(),
        });
    }
    emitSessionTranscriptUpdate(sessionFile);
    return sessionEntry;
}
function resolveCliTranscriptReplyText(result) {
    const visibleText = result.meta.finalAssistantVisibleText?.trim();
    if (visibleText) {
        return visibleText;
    }
    return (result.payloads ?? [])
        .filter((payload) => !payload.isError && !payload.isReasoning)
        .map((payload) => payload.text?.trim() ?? "")
        .filter(Boolean)
        .join("\n\n");
}
function isClaudeCliProvider(provider) {
    return provider.trim().toLowerCase() === "claude-cli";
}
export async function persistAcpTurnTranscript(params) {
    return await persistTextTurnTranscript({
        ...params,
        assistant: {
            api: "openai-responses",
            provider: "openclaw",
            model: "acp-runtime",
        },
    });
}
export async function persistCliTurnTranscript(params) {
    const replyText = resolveCliTranscriptReplyText(params.result);
    const provider = params.result.meta.agentMeta?.provider?.trim() ?? "cli";
    const model = params.result.meta.agentMeta?.model?.trim() ?? "default";
    return await persistTextTurnTranscript({
        body: params.body,
        transcriptBody: params.transcriptBody,
        finalText: replyText,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionEntry: params.sessionEntry,
        sessionStore: params.sessionStore,
        storePath: params.storePath,
        sessionAgentId: params.sessionAgentId,
        threadId: params.threadId,
        sessionCwd: params.sessionCwd,
        assistant: {
            api: "cli",
            provider,
            model,
            usage: params.result.meta.agentMeta?.usage,
        },
    });
}
export function runAgentAttempt(params) {
    const effectivePrompt = resolveFallbackRetryPrompt({
        body: params.body,
        isFallbackRetry: params.isFallbackRetry,
        sessionHasHistory: params.sessionHasHistory,
    });
    const bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(params.sessionEntry?.systemPromptReport);
    const bootstrapPromptWarningSignature = bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1];
    const sessionPinnedAgentHarnessId = resolveSessionPinnedAgentHarnessId({
        cfg: params.cfg,
        sessionAgentId: params.sessionAgentId,
        sessionEntry: params.sessionEntry,
        sessionHasHistory: params.sessionHasHistory,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey ?? params.sessionId,
    });
    const agentHarnessPolicy = resolveAgentHarnessPolicy({
        provider: params.providerOverride,
        modelId: params.modelOverride,
        config: params.cfg,
        agentId: params.sessionAgentId,
        sessionKey: params.sessionKey ?? params.sessionId,
    });
    const runtimeAuthPlan = buildAgentRuntimeAuthPlan({
        provider: params.providerOverride,
        authProfileProvider: params.authProfileProvider,
        sessionAuthProfileId: params.sessionEntry?.authProfileOverride,
        config: params.cfg,
        workspaceDir: params.workspaceDir,
        harnessId: sessionPinnedAgentHarnessId,
        harnessRuntime: agentHarnessPolicy.runtime,
        allowHarnessAuthProfileForwarding: !isCliProvider(params.providerOverride, params.cfg),
    });
    const authProfileId = runtimeAuthPlan.forwardedAuthProfileId;
    if (isCliProvider(params.providerOverride, params.cfg)) {
        const cliSessionBinding = getCliSessionBinding(params.sessionEntry, params.providerOverride);
        const resolveReusableCliSessionBinding = async () => {
            if (!isClaudeCliProvider(params.providerOverride) ||
                !cliSessionBinding?.sessionId ||
                (await claudeCliSessionTranscriptHasContent({ sessionId: cliSessionBinding.sessionId }))) {
                return cliSessionBinding;
            }
            log.warn(`cli session reset: provider=${sanitizeForLog(params.providerOverride)} reason=transcript-missing sessionKey=${params.sessionKey ?? params.sessionId}`);
            if (params.sessionKey && params.sessionStore && params.storePath) {
                params.sessionEntry =
                    (await clearCliSessionInStore({
                        provider: params.providerOverride,
                        sessionKey: params.sessionKey,
                        sessionStore: params.sessionStore,
                        storePath: params.storePath,
                    })) ?? params.sessionEntry;
            }
            return undefined;
        };
        const runCliWithSession = (nextCliSessionId, activeCliSessionBinding = cliSessionBinding) => runCliAgent({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            agentId: params.sessionAgentId,
            trigger: "user",
            sessionFile: params.sessionFile,
            workspaceDir: params.workspaceDir,
            config: params.cfg,
            prompt: effectivePrompt,
            provider: params.providerOverride,
            model: params.modelOverride,
            thinkLevel: params.resolvedThinkLevel,
            timeoutMs: params.timeoutMs,
            runId: params.runId,
            extraSystemPrompt: params.opts.extraSystemPrompt,
            cliSessionId: nextCliSessionId,
            cliSessionBinding: nextCliSessionId === activeCliSessionBinding?.sessionId
                ? activeCliSessionBinding
                : undefined,
            authProfileId,
            bootstrapPromptWarningSignaturesSeen,
            bootstrapPromptWarningSignature,
            images: params.isFallbackRetry ? undefined : params.opts.images,
            imageOrder: params.isFallbackRetry ? undefined : params.opts.imageOrder,
            skillsSnapshot: params.skillsSnapshot,
            messageChannel: params.messageChannel,
            streamParams: params.opts.streamParams,
            messageProvider: params.messageChannel,
            agentAccountId: params.runContext.accountId,
            senderIsOwner: params.opts.senderIsOwner,
        });
        return resolveReusableCliSessionBinding().then(async (activeCliSessionBinding) => {
            try {
                return await runCliWithSession(activeCliSessionBinding?.sessionId, activeCliSessionBinding);
            }
            catch (err) {
                if (err instanceof FailoverError &&
                    err.reason === "session_expired" &&
                    activeCliSessionBinding?.sessionId &&
                    params.sessionKey &&
                    params.sessionStore &&
                    params.storePath) {
                    log.warn(`CLI session expired, clearing from session store: provider=${sanitizeForLog(params.providerOverride)} sessionKey=${params.sessionKey}`);
                    params.sessionEntry =
                        (await clearCliSessionInStore({
                            provider: params.providerOverride,
                            sessionKey: params.sessionKey,
                            sessionStore: params.sessionStore,
                            storePath: params.storePath,
                        })) ?? params.sessionEntry;
                    return await runCliWithSession(undefined).then(async (result) => {
                        if (result.meta.agentMeta?.cliSessionBinding?.sessionId &&
                            params.sessionKey &&
                            params.sessionStore &&
                            params.storePath) {
                            const entry = params.sessionStore[params.sessionKey];
                            if (entry) {
                                const updatedEntry = { ...entry };
                                setCliSessionBinding(updatedEntry, params.providerOverride, result.meta.agentMeta.cliSessionBinding);
                                updatedEntry.updatedAt = Date.now();
                                await persistSessionEntry({
                                    sessionStore: params.sessionStore,
                                    sessionKey: params.sessionKey,
                                    storePath: params.storePath,
                                    entry: updatedEntry,
                                });
                            }
                        }
                        return result;
                    });
                }
                throw err;
            }
        });
    }
    return runEmbeddedPiAgent({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentId: params.sessionAgentId,
        trigger: "user",
        messageChannel: params.messageChannel,
        agentAccountId: params.runContext.accountId,
        messageTo: params.opts.replyTo ?? params.opts.to,
        messageThreadId: params.opts.threadId,
        groupId: params.runContext.groupId,
        groupChannel: params.runContext.groupChannel,
        groupSpace: params.runContext.groupSpace,
        spawnedBy: params.spawnedBy,
        currentChannelId: params.runContext.currentChannelId,
        currentThreadTs: params.runContext.currentThreadTs,
        replyToMode: params.runContext.replyToMode,
        hasRepliedRef: params.runContext.hasRepliedRef,
        senderIsOwner: params.opts.senderIsOwner,
        sessionFile: params.sessionFile,
        workspaceDir: params.workspaceDir,
        config: params.cfg,
        agentHarnessId: sessionPinnedAgentHarnessId,
        skillsSnapshot: params.skillsSnapshot,
        prompt: effectivePrompt,
        images: params.isFallbackRetry ? undefined : params.opts.images,
        imageOrder: params.isFallbackRetry ? undefined : params.opts.imageOrder,
        clientTools: params.opts.clientTools,
        provider: params.providerOverride,
        model: params.modelOverride,
        authProfileId,
        authProfileIdSource: authProfileId ? params.sessionEntry?.authProfileOverrideSource : undefined,
        thinkLevel: params.resolvedThinkLevel,
        verboseLevel: params.resolvedVerboseLevel,
        timeoutMs: params.timeoutMs,
        runId: params.runId,
        lane: params.opts.lane,
        abortSignal: params.opts.abortSignal,
        extraSystemPrompt: params.opts.extraSystemPrompt,
        bootstrapContextMode: params.opts.bootstrapContextMode,
        bootstrapContextRunKind: params.opts.bootstrapContextRunKind,
        internalEvents: params.opts.internalEvents,
        inputProvenance: params.opts.inputProvenance,
        streamParams: params.opts.streamParams,
        agentDir: params.agentDir,
        allowTransientCooldownProbe: params.allowTransientCooldownProbe,
        cleanupBundleMcpOnRunEnd: params.opts.cleanupBundleMcpOnRunEnd,
        onAgentEvent: params.onAgentEvent,
        bootstrapPromptWarningSignaturesSeen,
        bootstrapPromptWarningSignature,
    });
}
function resolveSessionPinnedAgentHarnessId(params) {
    if (params.sessionEntry?.sessionId !== params.sessionId) {
        return resolveConfiguredAgentHarnessId(params);
    }
    if (params.sessionEntry.agentHarnessId) {
        return params.sessionEntry.agentHarnessId;
    }
    const configuredAgentHarnessId = resolveConfiguredAgentHarnessId(params);
    if (configuredAgentHarnessId) {
        return configuredAgentHarnessId;
    }
    if (!params.sessionHasHistory) {
        return undefined;
    }
    return "pi";
}
function resolveConfiguredAgentHarnessId(params) {
    const policy = resolveAgentHarnessPolicy({
        config: params.cfg,
        agentId: params.sessionAgentId,
        sessionKey: params.sessionKey,
    });
    return policy.runtime === "auto" ? undefined : policy.runtime;
}
export function buildAcpResult(params) {
    const normalizedFinalPayload = normalizeReplyPayload({
        text: params.payloadText,
    });
    const payloads = normalizedFinalPayload ? [normalizedFinalPayload] : [];
    return {
        payloads,
        meta: {
            durationMs: Date.now() - params.startedAt,
            aborted: params.abortSignal?.aborted === true,
            stopReason: params.stopReason,
        },
    };
}
export function emitAcpLifecycleStart(params) {
    emitAgentEvent({
        runId: params.runId,
        stream: "lifecycle",
        data: {
            phase: "start",
            startedAt: params.startedAt,
        },
    });
}
export function emitAcpLifecycleEnd(params) {
    emitAgentEvent({
        runId: params.runId,
        stream: "lifecycle",
        data: {
            phase: "end",
            endedAt: Date.now(),
        },
    });
}
export function emitAcpLifecycleError(params) {
    emitAgentEvent({
        runId: params.runId,
        stream: "lifecycle",
        data: {
            phase: "error",
            error: params.message,
            endedAt: Date.now(),
        },
    });
}
export function emitAcpAssistantDelta(params) {
    emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: {
            text: params.text,
            delta: params.delta,
        },
    });
}
