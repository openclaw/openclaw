import crypto from "node:crypto";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import {
  cleanupFailedAcpSpawn,
  type AcpSpawnRuntimeCloseHandle,
} from "../acp/control-plane/spawn.js";
import { isAcpEnabledByPolicy, resolveAcpAgentPolicyError } from "../acp/policy.js";
import { isAcpRuntimeError } from "../acp/runtime/errors.js";
import {
  resolveAcpSessionCwd,
  resolveAcpThreadSessionDetailLines,
} from "../acp/runtime/session-identifiers.js";
import type { AcpRuntimeSessionMode } from "../acp/runtime/types.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../channels/thread-bindings-messages.js";
import {
  formatThreadBindingDisabledError,
  formatThreadBindingSpawnDisabledError,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingSpawnPolicy,
} from "../channels/thread-bindings-policy.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { resolveConversationIdFromTargets } from "../infra/outbound/conversation-id.js";
import {
  getSessionBindingService,
  isSessionBindingError,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import {
  type AcpSpawnParentRelayHandle,
  resolveAcpSpawnStreamLogPath,
  startAcpSpawnParentStreamRelay,
} from "./acp-spawn-parent-stream.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";

export const ACP_SPAWN_MODES = ["run", "session"] as const;
export type SpawnAcpMode = (typeof ACP_SPAWN_MODES)[number];
export const ACP_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
export type SpawnAcpSandboxMode = (typeof ACP_SPAWN_SANDBOX_MODES)[number];
export const ACP_SPAWN_STREAM_TARGETS = ["parent"] as const;
export type SpawnAcpStreamTarget = (typeof ACP_SPAWN_STREAM_TARGETS)[number];

export type SpawnAcpParams = {
  task: string;
  label?: string;
  agentId?: string;
  cwd?: string;
  mode?: SpawnAcpMode;
  thread?: boolean;
  sandbox?: SpawnAcpSandboxMode;
  streamTo?: SpawnAcpStreamTarget;
};

export type SpawnAcpContext = {
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  sandboxed?: boolean;
};

export type SpawnAcpResult = {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  runId?: string;
  mode?: SpawnAcpMode;
  streamLogPath?: string;
  note?: string;
  error?: string;
};

export const ACP_SPAWN_ACCEPTED_NOTE =
  "initial ACP task queued in isolated session; follow-ups continue in the bound thread.";
export const ACP_SPAWN_SESSION_ACCEPTED_NOTE =
  "thread-bound ACP session stays active after this task; continue in-thread for follow-ups.";

export function resolveAcpSpawnRuntimePolicyError(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
  requesterSandboxed?: boolean;
  sandbox?: SpawnAcpSandboxMode;
}): string | undefined {
  const sandboxMode = params.sandbox === "require" ? "require" : "inherit";
  const requesterRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.requesterSessionKey,
  });
  const requesterSandboxed = params.requesterSandboxed === true || requesterRuntime.sandboxed;
  if (requesterSandboxed) {
    return 'Sandboxed sessions cannot spawn ACP sessions because runtime="acp" runs on the host. Use runtime="subagent" from sandboxed sessions.';
  }
  if (sandboxMode === "require") {
    return 'sessions_spawn sandbox="require" is unsupported for runtime="acp" because ACP sessions run outside the sandbox. Use runtime="subagent" or sandbox="inherit".';
  }
  return undefined;
}

type PreparedAcpThreadBinding = {
  channel: string;
  accountId: string;
  conversationId: string;
};

function resolveSpawnMode(params: {
  requestedMode?: SpawnAcpMode;
  threadRequested: boolean;
}): SpawnAcpMode {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  // Thread-bound spawns should default to persistent sessions.
  return params.threadRequested ? "session" : "run";
}

function resolveAcpSessionMode(mode: SpawnAcpMode): AcpRuntimeSessionMode {
  return mode === "session" ? "persistent" : "oneshot";
}

function resolveTargetAcpAgentId(params: {
  requestedAgentId?: string;
  cfg: OpenClawConfig;
}): { ok: true; agentId: string } | { ok: false; error: string } {
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
    error:
      "ACP target agent is not configured. Pass `agentId` in `sessions_spawn` or set `acp.defaultAgent` in config.",
  };
}

function normalizeOptionalAgentId(value: string | undefined | null): string | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  return normalizeAgentId(trimmed);
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function formatAcpBackendAvailabilityError(params: {
  error: unknown;
  cfg: OpenClawConfig;
}): string | null {
  if (!isAcpRuntimeError(params.error)) {
    return null;
  }
  if (
    params.error.code !== "ACP_BACKEND_MISSING" &&
    params.error.code !== "ACP_BACKEND_UNAVAILABLE"
  ) {
    return null;
  }

  const configuredBackend = params.cfg.acp?.backend?.trim().toLowerCase() || "acpx";
  const backendPluginEnabled = params.cfg.plugins?.entries?.[configuredBackend]?.enabled === true;
  const backendHint = backendPluginEnabled
    ? `backend "${configuredBackend}" is enabled in config, so this likely indicates runtime startup/health failure.`
    : `backend "${configuredBackend}" is not enabled under plugins.entries.${configuredBackend}.enabled.`;

  return [
    params.error.message,
    `ACP diagnostics: configured backend=${configuredBackend}; ${backendHint}`,
    "Try: 1) ensure acp.enabled=true and acp.backend matches a loaded runtime plugin, 2) run `openclaw plugins list`, 3) run `/acp doctor`.",
  ].join(" ");
}

function resolveConversationIdForThreadBinding(params: {
  to?: string;
  threadId?: string | number;
}): string | undefined {
  return resolveConversationIdFromTargets({
    threadId: params.threadId,
    targets: [params.to],
  });
}

function prepareAcpThreadBinding(params: {
  cfg: OpenClawConfig;
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
}): { ok: true; binding: PreparedAcpThreadBinding } | { ok: false; error: string } {
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

export async function spawnAcpDirect(
  params: SpawnAcpParams,
  ctx: SpawnAcpContext,
): Promise<SpawnAcpResult> {
  const cfg = loadConfig();
  if (!isAcpEnabledByPolicy(cfg)) {
    return {
      status: "forbidden",
      error: "ACP is disabled by policy (`acp.enabled=false`).",
    };
  }
  const streamToParentRequested = params.streamTo === "parent";
  const parentSessionKey = ctx.agentSessionKey?.trim();
  if (streamToParentRequested && !parentSessionKey) {
    return {
      status: "error",
      error: 'sessions_spawn streamTo="parent" requires an active requester session context.',
    };
  }
  const runtimePolicyError = resolveAcpSpawnRuntimePolicyError({
    cfg,
    requesterSessionKey: ctx.agentSessionKey,
    requesterSandboxed: ctx.sandboxed,
    sandbox: params.sandbox,
  });
  if (runtimePolicyError) {
    return {
      status: "forbidden",
      error: runtimePolicyError,
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

  let preparedBinding: PreparedAcpThreadBinding | null = null;
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
  let binding: SessionBindingRecord | null = null;
  let sessionCreated = false;
  let initializedRuntime: AcpSpawnRuntimeCloseHandle | undefined;
  try {
    await callGateway({
      method: "sessions.patch",
      params: {
        key: sessionKey,
        ...(params.label ? { label: params.label } : {}),
      },
      timeoutMs: 10_000,
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
        throw new Error(
          `Failed to create and bind a ${preparedBinding.channel} thread for this ACP session.`,
        );
      }
    }
  } catch (err) {
    await cleanupFailedAcpSpawn({
      cfg,
      sessionKey,
      shouldDeleteSession: sessionCreated,
      deleteTranscript: true,
      runtimeCloseHandle: initializedRuntime,
    });
    const backendAvailabilityError = formatAcpBackendAvailabilityError({
      error: err,
      cfg,
    });
    return {
      status: "error",
      error: isSessionBindingError(err)
        ? err.message
        : backendAvailabilityError || summarizeError(err),
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
  const fallbackThreadId =
    fallbackThreadIdRaw != null ? String(fallbackThreadIdRaw).trim() || undefined : undefined;
  const deliveryThreadId = boundThreadId ?? fallbackThreadId;
  const inferredDeliveryTo = boundThreadId
    ? `channel:${boundThreadId}`
    : requesterOrigin?.to?.trim() || (deliveryThreadId ? `channel:${deliveryThreadId}` : undefined);
  const hasDeliveryTarget = Boolean(requesterOrigin?.channel && inferredDeliveryTo);
  // Fresh one-shot ACP runs should bootstrap the worker first, then let higher layers
  // decide how to relay status. Inline delivery is reserved for thread-bound sessions.
  const useInlineDelivery =
    hasDeliveryTarget && spawnMode === "session" && !streamToParentRequested;
  const childIdem = crypto.randomUUID();
  let childRunId: string = childIdem;
  const streamLogPath =
    streamToParentRequested && parentSessionKey
      ? resolveAcpSpawnStreamLogPath({
          childSessionKey: sessionKey,
        })
      : undefined;
  let parentRelay: AcpSpawnParentRelayHandle | undefined;
  if (streamToParentRequested && parentSessionKey) {
    // Register relay before dispatch so fast lifecycle failures are not missed.
    parentRelay = startAcpSpawnParentStreamRelay({
      runId: childIdem,
      parentSessionKey,
      childSessionKey: sessionKey,
      agentId: targetAgentId,
      logPath: streamLogPath,
      emitStartNotice: false,
    });
  }
  try {
    const response = await callGateway<{ runId?: string }>({
      method: "agent",
      params: {
        message: params.task,
        sessionKey,
        channel: useInlineDelivery ? requesterOrigin?.channel : undefined,
        to: useInlineDelivery ? inferredDeliveryTo : undefined,
        accountId: useInlineDelivery ? (requesterOrigin?.accountId ?? undefined) : undefined,
        threadId: useInlineDelivery ? deliveryThreadId : undefined,
        idempotencyKey: childIdem,
        deliver: useInlineDelivery,
        label: params.label || undefined,
      },
      timeoutMs: 10_000,
    });
    if (typeof response?.runId === "string" && response.runId.trim()) {
      childRunId = response.runId.trim();
    }
  } catch (err) {
    parentRelay?.dispose();
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

  if (streamToParentRequested && parentSessionKey) {
    if (parentRelay && childRunId !== childIdem) {
      parentRelay.dispose();
      // Defensive fallback if gateway returns a runId that differs from idempotency key.
      parentRelay = startAcpSpawnParentStreamRelay({
        runId: childRunId,
        parentSessionKey,
        childSessionKey: sessionKey,
        agentId: targetAgentId,
        logPath: streamLogPath,
        emitStartNotice: false,
      });
    }
    parentRelay?.notifyStarted();
    return {
      status: "accepted",
      childSessionKey: sessionKey,
      runId: childRunId,
      mode: spawnMode,
      ...(streamLogPath ? { streamLogPath } : {}),
      note: spawnMode === "session" ? ACP_SPAWN_SESSION_ACCEPTED_NOTE : ACP_SPAWN_ACCEPTED_NOTE,
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
