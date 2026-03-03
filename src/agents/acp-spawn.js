import crypto from "node:crypto";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import { cleanupFailedAcpSpawn, } from "../acp/control-plane/spawn.js";
import { isAcpEnabledByPolicy, resolveAcpAgentPolicyError } from "../acp/policy.js";
import { resolveAcpSessionCwd, resolveAcpThreadSessionDetailLines, } from "../acp/runtime/session-identifiers.js";
import { resolveThreadBindingIntroText, resolveThreadBindingThreadName, } from "../channels/thread-bindings-messages.js";
import { formatThreadBindingDisabledError, formatThreadBindingSpawnDisabledError, resolveThreadBindingIdleTimeoutMsForChannel, resolveThreadBindingMaxAgeMsForChannel, resolveThreadBindingSpawnPolicy, } from "../channels/thread-bindings-policy.js";
import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { resolveConversationIdFromTargets } from "../infra/outbound/conversation-id.js";
import { getSessionBindingService, isSessionBindingError, } from "../infra/outbound/session-binding-service.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
export const ACP_SPAWN_MODES = ["run", "session"];
export const ACP_SPAWN_ACCEPTED_NOTE = "initial ACP task queued in isolated session; follow-ups continue in the bound thread.";
export const ACP_SPAWN_SESSION_ACCEPTED_NOTE = "thread-bound ACP session stays active after this task; continue in-thread for follow-ups.";
function resolveSpawnMode(params) {
    if (params.requestedMode === "run" || params.requestedMode === "session") {
        return params.requestedMode;
    }
    // Thread-bound spawns should default to persistent sessions.
    return params.threadRequested ? "session" : "run";
}
function resolveAcpSessionMode(mode) {
    return mode === "session" ? "persistent" : "oneshot";
}
function resolveTargetAcpAgentId(params) {
    const requested = normalizeOptionalAgentId(params.requestedAgentId);
    if (requested) {
        return { ok: true, agentId: requested };
    }
    const configuredDefault = normalizeOptionalAgentId(params.cfg.acp?.defaultAgent);
    if (configuredDefault) {
        return { ok: true, agentId: configuredDefault };
    }
    return {
        ok: false,
        error: "ACP target agent is not configured. Pass `agentId` in `sessions_spawn` or set `acp.defaultAgent` in config.",
    };
}
function normalizeOptionalAgentId(value) {
    const trimmed = (value ?? "").trim();
    if (!trimmed) {
        return undefined;
    }
    return normalizeAgentId(trimmed);
}
function summarizeError(err) {
    if (err instanceof Error) {
        return err.message;
    }
    if (typeof err === "string") {
        return err;
    }
    return "error";
}
function resolveConversationIdForThreadBinding(params) {
    return resolveConversationIdFromTargets({
        threadId: params.threadId,
        targets: [params.to],
    });
}
function prepareAcpThreadBinding(params) {
    const channel = params.channel?.trim().toLowerCase();
    if (!channel) {
        return {
            ok: false,
            error: "thread=true for ACP sessions requires a channel context.",
        };
    }
    const accountId = params.accountId?.trim() || "default";
    const policy = resolveThreadBindingSpawnPolicy({
        cfg: params.cfg,
        channel,
        accountId,
        kind: "acp",
    });
    if (!policy.enabled) {
        return {
            ok: false,
            error: formatThreadBindingDisabledError({
                channel: policy.channel,
                accountId: policy.accountId,
                kind: "acp",
            }),
        };
    }
    if (!policy.spawnEnabled) {
        return {
            ok: false,
            error: formatThreadBindingSpawnDisabledError({
                channel: policy.channel,
                accountId: policy.accountId,
                kind: "acp",
            }),
        };
    }
    const bindingService = getSessionBindingService();
    const capabilities = bindingService.getCapabilities({
        channel: policy.channel,
        accountId: policy.accountId,
    });
    if (!capabilities.adapterAvailable) {
        return {
            ok: false,
            error: `Thread bindings are unavailable for ${policy.channel}.`,
        };
    }
    if (!capabilities.bindSupported || !capabilities.placements.includes("child")) {
        return {
            ok: false,
            error: `Thread bindings do not support ACP thread spawn for ${policy.channel}.`,
        };
    }
    const conversationId = resolveConversationIdForThreadBinding({
        to: params.to,
        threadId: params.threadId,
    });
    if (!conversationId) {
        return {
            ok: false,
            error: `Could not resolve a ${policy.channel} conversation for ACP thread spawn.`,
        };
    }
    return {
        ok: true,
        binding: {
            channel: policy.channel,
            accountId: policy.accountId,
            conversationId,
        },
    };
}
export async function spawnAcpDirect(params, ctx) {
    const cfg = loadConfig();
    if (!isAcpEnabledByPolicy(cfg)) {
        return {
            status: "forbidden",
            error: "ACP is disabled by policy (`acp.enabled=false`).",
        };
    }
    const requestThreadBinding = params.thread === true;
    const spawnMode = resolveSpawnMode({
        requestedMode: params.mode,
        threadRequested: requestThreadBinding,
    });
    if (spawnMode === "session" && !requestThreadBinding) {
        return {
            status: "error",
            error: 'mode="session" requires thread=true so the ACP session can stay bound to a thread.',
        };
    }
    const targetAgentResult = resolveTargetAcpAgentId({
        requestedAgentId: params.agentId,
        cfg,
    });
    if (!targetAgentResult.ok) {
        return {
            status: "error",
            error: targetAgentResult.error,
        };
    }
    const targetAgentId = targetAgentResult.agentId;
    const agentPolicyError = resolveAcpAgentPolicyError(cfg, targetAgentId);
    if (agentPolicyError) {
        return {
            status: "forbidden",
            error: agentPolicyError.message,
        };
    }
    const sessionKey = `agent:${targetAgentId}:acp:${crypto.randomUUID()}`;
    const runtimeMode = resolveAcpSessionMode(spawnMode);
    let preparedBinding = null;
    if (requestThreadBinding) {
        const prepared = prepareAcpThreadBinding({
            cfg,
            channel: ctx.agentChannel,
            accountId: ctx.agentAccountId,
            to: ctx.agentTo,
            threadId: ctx.agentThreadId,
        });
        if (!prepared.ok) {
            return {
                status: "error",
                error: prepared.error,
            };
        }
        preparedBinding = prepared.binding;
    }
    const acpManager = getAcpSessionManager();
    const bindingService = getSessionBindingService();
    let binding = null;
    let sessionCreated = false;
    let initializedRuntime;
    try {
        await callGateway({
            method: "sessions.patch",
            params: {
                key: sessionKey,
                ...(params.label ? { label: params.label } : {}),
            },
            timeoutMs: 10000,
        });
        sessionCreated = true;
        const initialized = await acpManager.initializeSession({
            cfg,
            sessionKey,
            agent: targetAgentId,
            mode: runtimeMode,
            cwd: params.cwd,
            backendId: cfg.acp?.backend,
        });
        initializedRuntime = {
            runtime: initialized.runtime,
            handle: initialized.handle,
        };
        if (preparedBinding) {
            binding = await bindingService.bind({
                targetSessionKey: sessionKey,
                targetKind: "session",
                conversation: {
                    channel: preparedBinding.channel,
                    accountId: preparedBinding.accountId,
                    conversationId: preparedBinding.conversationId,
                },
                placement: "child",
                metadata: {
                    threadName: resolveThreadBindingThreadName({
                        agentId: targetAgentId,
                        label: params.label || targetAgentId,
                    }),
                    agentId: targetAgentId,
                    label: params.label || undefined,
                    boundBy: "system",
                    introText: resolveThreadBindingIntroText({
                        agentId: targetAgentId,
                        label: params.label || undefined,
                        idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
                            cfg,
                            channel: preparedBinding.channel,
                            accountId: preparedBinding.accountId,
                        }),
                        maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
                            cfg,
                            channel: preparedBinding.channel,
                            accountId: preparedBinding.accountId,
                        }),
                        sessionCwd: resolveAcpSessionCwd(initialized.meta),
                        sessionDetails: resolveAcpThreadSessionDetailLines({
                            sessionKey,
                            meta: initialized.meta,
                        }),
                    }),
                },
            });
            if (!binding?.conversation.conversationId) {
                throw new Error(`Failed to create and bind a ${preparedBinding.channel} thread for this ACP session.`);
            }
        }
    }
    catch (err) {
        await cleanupFailedAcpSpawn({
            cfg,
            sessionKey,
            shouldDeleteSession: sessionCreated,
            deleteTranscript: true,
            runtimeCloseHandle: initializedRuntime,
        });
        return {
            status: "error",
            error: isSessionBindingError(err) ? err.message : summarizeError(err),
        };
    }
    const requesterOrigin = normalizeDeliveryContext({
        channel: ctx.agentChannel,
        accountId: ctx.agentAccountId,
        to: ctx.agentTo,
        threadId: ctx.agentThreadId,
    });
    // For thread-bound ACP spawns, force bootstrap delivery to the new child thread.
    const boundThreadIdRaw = binding?.conversation.conversationId;
    const boundThreadId = boundThreadIdRaw ? String(boundThreadIdRaw).trim() || undefined : undefined;
    const fallbackThreadIdRaw = requesterOrigin?.threadId;
    const fallbackThreadId = fallbackThreadIdRaw != null ? String(fallbackThreadIdRaw).trim() || undefined : undefined;
    const deliveryThreadId = boundThreadId ?? fallbackThreadId;
    const inferredDeliveryTo = boundThreadId
        ? `channel:${boundThreadId}`
        : requesterOrigin?.to?.trim() || (deliveryThreadId ? `channel:${deliveryThreadId}` : undefined);
    const hasDeliveryTarget = Boolean(requesterOrigin?.channel && inferredDeliveryTo);
    const childIdem = crypto.randomUUID();
    let childRunId = childIdem;
    try {
        const response = await callGateway({
            method: "agent",
            params: {
                message: params.task,
                sessionKey,
                channel: hasDeliveryTarget ? requesterOrigin?.channel : undefined,
                to: hasDeliveryTarget ? inferredDeliveryTo : undefined,
                accountId: hasDeliveryTarget ? (requesterOrigin?.accountId ?? undefined) : undefined,
                threadId: hasDeliveryTarget ? deliveryThreadId : undefined,
                idempotencyKey: childIdem,
                deliver: hasDeliveryTarget,
                label: params.label || undefined,
            },
            timeoutMs: 10000,
        });
        if (typeof response?.runId === "string" && response.runId.trim()) {
            childRunId = response.runId.trim();
        }
    }
    catch (err) {
        await cleanupFailedAcpSpawn({
            cfg,
            sessionKey,
            shouldDeleteSession: true,
            deleteTranscript: true,
        });
        return {
            status: "error",
            error: summarizeError(err),
            childSessionKey: sessionKey,
        };
    }
    return {
        status: "accepted",
        childSessionKey: sessionKey,
        runId: childRunId,
        mode: spawnMode,
        note: spawnMode === "session" ? ACP_SPAWN_SESSION_ACCEPTED_NOTE : ACP_SPAWN_ACCEPTED_NOTE,
    };
}
