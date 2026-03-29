import crypto from "node:crypto";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import {
  cleanupFailedAcpSpawn,
  type AcpSpawnRuntimeCloseHandle,
} from "../acp/control-plane/spawn.js";
import { isAcpEnabledByPolicy, resolveAcpAgentPolicyError } from "../acp/policy.js";
import {
  resolveAcpSessionCwd,
  resolveAcpThreadSessionDetailLines,
} from "../acp/runtime/session-identifiers.js";
import type { AcpRuntimeSessionMode } from "../acp/runtime/types.js";
import { DEFAULT_HEARTBEAT_EVERY } from "../auto-reply/heartbeat.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../channels/thread-bindings-messages.js";
import {
  formatThreadBindingDisabledError,
  formatThreadBindingSpawnDisabledError,
  requiresNativeThreadContextForThreadHere,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingSpawnPolicy,
} from "../channels/thread-bindings-policy.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath, type SessionEntry } from "../config/sessions.js";
import { resolveSessionTranscriptFile } from "../config/sessions/transcript.js";
import { callGateway } from "../gateway/call.js";
import { areHeartbeatsEnabled } from "../infra/heartbeat-wake.js";
import { resolveConversationIdFromTargets } from "../infra/outbound/conversation-id.js";
import {
  getSessionBindingService,
  isSessionBindingError,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import {
  deliveryContextFromSession,
  formatConversationTarget,
  normalizeDeliveryContext,
  resolveConversationDeliveryTarget,
} from "../utils/delivery-context.js";
import {
  type AcpSpawnParentRelayHandle,
  resolveAcpSpawnStreamLogPath,
  startAcpSpawnParentStreamRelay,
} from "./acp-spawn-parent-stream.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./tools/sessions-helpers.js";

const log = createSubsystemLogger("agents/acp-spawn");

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
  resumeSessionId?: string;
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
  placement: "current" | "child";
  conversationId: string;
};

type AcpSpawnInitializedSession = Awaited<
  ReturnType<ReturnType<typeof getAcpSessionManager>["initializeSession"]>
>;

type AcpSpawnInitializedRuntime = {
  initialized: AcpSpawnInitializedSession;
  runtimeCloseHandle: AcpSpawnRuntimeCloseHandle;
  sessionId?: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
};

type AcpSpawnRequesterState = {
  parentSessionKey?: string;
  isSubagentSession: boolean;
  hasActiveSubagentBinding: boolean;
  hasThreadContext: boolean;
  heartbeatEnabled: boolean;
  heartbeatRelayRouteUsable: boolean;
  origin: ReturnType<typeof normalizeDeliveryContext>;
};

type AcpSpawnStreamPlan = {
  implicitStreamToParent: boolean;
  effectiveStreamToParent: boolean;
};

type AcpSpawnBootstrapDeliveryPlan = {
  useInlineDelivery: boolean;
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string;
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

function isHeartbeatEnabledForSessionAgent(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
}): boolean {
  if (!areHeartbeatsEnabled()) {
    return false;
  }
  const requesterAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  if (!requesterAgentId) {
    return true;
  }

  const agentEntries = params.cfg.agents?.list ?? [];
  const hasExplicitHeartbeatAgents = agentEntries.some((entry) => Boolean(entry?.heartbeat));
  const enabledByPolicy = hasExplicitHeartbeatAgents
    ? agentEntries.some(
        (entry) => Boolean(entry?.heartbeat) && normalizeAgentId(entry?.id) === requesterAgentId,
      )
    : requesterAgentId === resolveDefaultAgentId(params.cfg);
  if (!enabledByPolicy) {
    return false;
  }

  const heartbeatEvery =
    resolveAgentConfig(params.cfg, requesterAgentId)?.heartbeat?.every ??
    params.cfg.agents?.defaults?.heartbeat?.every ??
    DEFAULT_HEARTBEAT_EVERY;
  const trimmedEvery = typeof heartbeatEvery === "string" ? heartbeatEvery.trim() : "";
  if (!trimmedEvery) {
    return false;
  }
  try {
    return parseDurationMs(trimmedEvery, { defaultUnit: "m" }) > 0;
  } catch {
    return false;
  }
}

function resolveHeartbeatConfigForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["heartbeat"] {
  const defaults = params.cfg.agents?.defaults?.heartbeat;
  const overrides = resolveAgentConfig(params.cfg, params.agentId)?.heartbeat;
  if (!defaults && !overrides) {
    return undefined;
  }
  return {
    ...defaults,
    ...overrides,
  };
}

function hasSessionLocalHeartbeatRelayRoute(params: {
  cfg: OpenClawConfig;
  parentSessionKey: string;
  requesterAgentId: string;
}): boolean {
  const scope = params.cfg.session?.scope ?? "per-sender";
  if (scope === "global") {
    return false;
  }

  const heartbeat = resolveHeartbeatConfigForAgent({
    cfg: params.cfg,
    agentId: params.requesterAgentId,
  });
  if ((heartbeat?.target ?? "none") !== "last") {
    return false;
  }

  // Explicit delivery overrides are not session-local and can route updates
  // to unrelated destinations (for example a pinned ops channel).
  if (typeof heartbeat?.to === "string" && heartbeat.to.trim().length > 0) {
    return false;
  }
  if (typeof heartbeat?.accountId === "string" && heartbeat.accountId.trim().length > 0) {
    return false;
  }

  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.requesterAgentId,
  });
  const sessionStore = loadSessionStore(storePath);
  const parentEntry = sessionStore[params.parentSessionKey];
  const parentDeliveryContext = deliveryContextFromSession(parentEntry);
  return Boolean(parentDeliveryContext?.channel && parentDeliveryContext.to);
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

function resolveRequesterInternalSessionKey(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
}): string {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const requesterSessionKey = params.requesterSessionKey?.trim();
  return requesterSessionKey
    ? resolveInternalSessionKey({
        key: requesterSessionKey,
        alias,
        mainKey,
      })
    : alias;
}

async function persistAcpSpawnSessionFileBestEffort(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  agentId: string;
  threadId?: string | number;
  stage: "spawn" | "thread-bind";
}): Promise<SessionEntry | undefined> {
  try {
    const resolvedSessionFile = await resolveSessionTranscriptFile({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
      agentId: params.agentId,
      threadId: params.threadId,
    });
    return resolvedSessionFile.sessionEntry;
  } catch (error) {
    log.warn(
      `ACP session-file persistence failed during ${params.stage} for ${params.sessionKey}: ${summarizeError(error)}`,
    );
    return params.sessionEntry;
  }
}

function resolveConversationIdForThreadBinding(params: {
  channel?: string;
  to?: string;
  threadId?: string | number;
}): string | undefined {
  const genericConversationId = resolveConversationIdFromTargets({
    threadId: params.threadId,
    targets: [params.to],
  });
  if (genericConversationId) {
    return genericConversationId;
  }

  const channel = params.channel?.trim().toLowerCase();
  const target = params.to?.trim() || "";
  if (channel === "line") {
    const prefixed = target.match(/^line:(?:(?:user|group|room):)?([UCR][a-f0-9]{32})$/i)?.[1];
    if (prefixed) {
      return prefixed;
    }
    if (/^[UCR][a-f0-9]{32}$/i.test(target)) {
      return target;
    }
  }

  return undefined;
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
  const placement = requiresNativeThreadContextForThreadHere(policy.channel) ? "child" : "current";
  if (!capabilities.bindSupported || !capabilities.placements.includes(placement)) {
    return {
      ok: false,
      error: `Thread bindings do not support ${placement} placement for ${policy.channel}.`,
    };
  }
  const conversationId = resolveConversationIdForThreadBinding({
    channel: policy.channel,
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
      placement,
      conversationId,
    },
  };
}

function resolveAcpSpawnRequesterState(params: {
  cfg: OpenClawConfig;
  parentSessionKey?: string;
  ctx: SpawnAcpContext;
}): AcpSpawnRequesterState {
  const bindingService = getSessionBindingService();
  const requesterParsedSession = parseAgentSessionKey(params.parentSessionKey);
  const isSubagentSession =
    Boolean(requesterParsedSession) && isSubagentSessionKey(params.parentSessionKey);
  const hasActiveSubagentBinding =
    isSubagentSession && params.parentSessionKey
      ? bindingService
          .listBySession(params.parentSessionKey)
          .some((record) => record.targetKind === "subagent" && record.status !== "ended")
      : false;
  const hasThreadContext =
    typeof params.ctx.agentThreadId === "string"
      ? params.ctx.agentThreadId.trim().length > 0
      : params.ctx.agentThreadId != null;
  const requesterAgentId = requesterParsedSession?.agentId;

  return {
    parentSessionKey: params.parentSessionKey,
    isSubagentSession,
    hasActiveSubagentBinding,
    hasThreadContext,
    heartbeatEnabled: isHeartbeatEnabledForSessionAgent({
      cfg: params.cfg,
      sessionKey: params.parentSessionKey,
    }),
    heartbeatRelayRouteUsable:
      params.parentSessionKey && requesterAgentId
        ? hasSessionLocalHeartbeatRelayRoute({
            cfg: params.cfg,
            parentSessionKey: params.parentSessionKey,
            requesterAgentId,
          })
        : false,
    origin: normalizeDeliveryContext({
      channel: params.ctx.agentChannel,
      accountId: params.ctx.agentAccountId,
      to: params.ctx.agentTo,
      threadId: params.ctx.agentThreadId,
    }),
  };
}

function resolveAcpSpawnStreamPlan(params: {
  spawnMode: SpawnAcpMode;
  requestThreadBinding: boolean;
  streamToParentRequested: boolean;
  requester: AcpSpawnRequesterState;
}): AcpSpawnStreamPlan {
  // For mode=run without thread binding, implicitly route output to parent
  // only for spawned subagent orchestrator sessions with heartbeat enabled
  // AND a session-local heartbeat delivery route (target=last + usable last route).
  // Skip requester sessions that are thread-bound (or carrying thread context)
  // so user-facing threads do not receive unsolicited ACP progress chatter
  // unless streamTo="parent" is explicitly requested. Use resolved spawnMode
  // (not params.mode) so default mode selection works.
  const implicitStreamToParent =
    !params.streamToParentRequested &&
    params.spawnMode === "run" &&
    !params.requestThreadBinding &&
    params.requester.isSubagentSession &&
    !params.requester.hasActiveSubagentBinding &&
    !params.requester.hasThreadContext &&
    params.requester.heartbeatEnabled &&
    params.requester.heartbeatRelayRouteUsable;

  return {
    implicitStreamToParent,
    effectiveStreamToParent: params.streamToParentRequested || implicitStreamToParent,
  };
}

async function initializeAcpSpawnRuntime(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  targetAgentId: string;
  runtimeMode: AcpRuntimeSessionMode;
  resumeSessionId?: string;
  cwd?: string;
}): Promise<AcpSpawnInitializedRuntime> {
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.targetAgentId });
  const sessionStore = loadSessionStore(storePath);
  let sessionEntry: SessionEntry | undefined = sessionStore[params.sessionKey];
  const sessionId = sessionEntry?.sessionId;
  if (sessionId) {
    sessionEntry = await persistAcpSpawnSessionFileBestEffort({
      sessionId,
      sessionKey: params.sessionKey,
      sessionStore,
      storePath,
      sessionEntry,
      agentId: params.targetAgentId,
      stage: "spawn",
    });
  }

  const initialized = await getAcpSessionManager().initializeSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agent: params.targetAgentId,
    mode: params.runtimeMode,
    resumeSessionId: params.resumeSessionId,
    cwd: params.cwd,
    backendId: params.cfg.acp?.backend,
  });

  return {
    initialized,
    runtimeCloseHandle: {
      runtime: initialized.runtime,
      handle: initialized.handle,
    },
    sessionId,
    sessionEntry,
    sessionStore,
    storePath,
  };
}

async function bindPreparedAcpThread(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  targetAgentId: string;
  label?: string;
  preparedBinding: PreparedAcpThreadBinding;
  initializedRuntime: AcpSpawnInitializedRuntime;
}): Promise<{
  binding: SessionBindingRecord;
  sessionEntry: SessionEntry | undefined;
}> {
  const binding = await getSessionBindingService().bind({
    targetSessionKey: params.sessionKey,
    targetKind: "session",
    conversation: {
      channel: params.preparedBinding.channel,
      accountId: params.preparedBinding.accountId,
      conversationId: params.preparedBinding.conversationId,
    },
    placement: params.preparedBinding.placement,
    metadata: {
      threadName: resolveThreadBindingThreadName({
        agentId: params.targetAgentId,
        label: params.label || params.targetAgentId,
      }),
      agentId: params.targetAgentId,
      label: params.label || undefined,
      boundBy: "system",
      introText: resolveThreadBindingIntroText({
        agentId: params.targetAgentId,
        label: params.label || undefined,
        idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
          cfg: params.cfg,
          channel: params.preparedBinding.channel,
          accountId: params.preparedBinding.accountId,
        }),
        maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
          cfg: params.cfg,
          channel: params.preparedBinding.channel,
          accountId: params.preparedBinding.accountId,
        }),
        sessionCwd: resolveAcpSessionCwd(params.initializedRuntime.initialized.meta),
        sessionDetails: resolveAcpThreadSessionDetailLines({
          sessionKey: params.sessionKey,
          meta: params.initializedRuntime.initialized.meta,
        }),
      }),
    },
  });
  if (!binding.conversation.conversationId) {
    throw new Error(
      params.preparedBinding.placement === "child"
        ? `Failed to create and bind a ${params.preparedBinding.channel} thread for this ACP session.`
        : `Failed to bind the current ${params.preparedBinding.channel} conversation for this ACP session.`,
    );
  }

  let sessionEntry = params.initializedRuntime.sessionEntry;
  if (params.initializedRuntime.sessionId && params.preparedBinding.placement === "child") {
    const boundThreadId = String(binding.conversation.conversationId).trim() || undefined;
    if (boundThreadId) {
      sessionEntry = await persistAcpSpawnSessionFileBestEffort({
        sessionId: params.initializedRuntime.sessionId,
        sessionKey: params.sessionKey,
        sessionStore: params.initializedRuntime.sessionStore,
        storePath: params.initializedRuntime.storePath,
        sessionEntry,
        agentId: params.targetAgentId,
        threadId: boundThreadId,
        stage: "thread-bind",
      });
    }
  }

  return { binding, sessionEntry };
}

function resolveAcpSpawnBootstrapDeliveryPlan(params: {
  spawnMode: SpawnAcpMode;
  requestThreadBinding: boolean;
  effectiveStreamToParent: boolean;
  requester: AcpSpawnRequesterState;
  binding: SessionBindingRecord | null;
}): AcpSpawnBootstrapDeliveryPlan {
  // Child-thread ACP spawns deliver bootstrap output to the new thread; current-conversation
  // binds deliver back to the originating target.
  const boundThreadIdRaw = params.binding?.conversation.conversationId;
  const boundThreadId = boundThreadIdRaw ? String(boundThreadIdRaw).trim() || undefined : undefined;
  const fallbackThreadIdRaw = params.requester.origin?.threadId;
  const fallbackThreadId =
    fallbackThreadIdRaw != null ? String(fallbackThreadIdRaw).trim() || undefined : undefined;
  const deliveryThreadId = boundThreadId ?? fallbackThreadId;
  const requesterConversationId = resolveConversationIdForThreadBinding({
    channel: params.requester.origin?.channel,
    threadId: fallbackThreadId,
    to: params.requester.origin?.to,
  });
  const bindingMatchesRequesterConversation = Boolean(
    params.requester.origin?.channel &&
    params.binding?.conversation.channel === params.requester.origin.channel &&
    params.binding?.conversation.accountId === (params.requester.origin.accountId ?? "default") &&
    requesterConversationId &&
    params.binding?.conversation.conversationId === requesterConversationId,
  );
  const boundDeliveryTarget = resolveConversationDeliveryTarget({
    channel: params.requester.origin?.channel ?? params.binding?.conversation.channel,
    conversationId: params.binding?.conversation.conversationId,
    parentConversationId: params.binding?.conversation.parentConversationId,
  });
  const inferredDeliveryTo =
    (bindingMatchesRequesterConversation ? params.requester.origin?.to?.trim() : undefined) ??
    boundDeliveryTarget.to ??
    params.requester.origin?.to?.trim() ??
    formatConversationTarget({
      channel: params.requester.origin?.channel,
      conversationId: deliveryThreadId,
    });
  const resolvedDeliveryThreadId = bindingMatchesRequesterConversation
    ? fallbackThreadId
    : (boundDeliveryTarget.threadId ?? deliveryThreadId);
  const hasDeliveryTarget = Boolean(params.requester.origin?.channel && inferredDeliveryTo);

  // Thread-bound session spawns always deliver inline to their bound thread.
  // Run-mode spawns use stream-to-parent when the requester is a subagent
  // orchestrator with an active heartbeat relay route. For all other run-mode
  // spawns from non-subagent requester sessions, fall back to inline delivery
  // so the result reaches the originating channel.
  const useInlineDelivery =
    hasDeliveryTarget &&
    !params.effectiveStreamToParent &&
    (params.spawnMode === "session" ||
      (!params.requester.isSubagentSession && !params.requestThreadBinding));

  return {
    useInlineDelivery,
    channel: useInlineDelivery ? params.requester.origin?.channel : undefined,
    accountId: useInlineDelivery ? (params.requester.origin?.accountId ?? undefined) : undefined,
    to: useInlineDelivery ? inferredDeliveryTo : undefined,
    threadId: useInlineDelivery ? resolvedDeliveryThreadId : undefined,
  };
}

export async function spawnAcpDirect(
  params: SpawnAcpParams,
  ctx: SpawnAcpContext,
): Promise<SpawnAcpResult> {
  const cfg = loadConfig();
  const requesterInternalKey = resolveRequesterInternalSessionKey({
    cfg,
    requesterSessionKey: ctx.agentSessionKey,
  });
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

  const requestThreadBinding = params.thread === true;
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

  const requesterState = resolveAcpSpawnRequesterState({
    cfg,
    parentSessionKey,
    ctx,
  });
  const { effectiveStreamToParent } = resolveAcpSpawnStreamPlan({
    spawnMode,
    requestThreadBinding,
    streamToParentRequested,
    requester: requesterState,
  });

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

  let binding: SessionBindingRecord | null = null;
  let sessionCreated = false;
  let initializedRuntime: AcpSpawnRuntimeCloseHandle | undefined;
  try {
    await callGateway({
      method: "sessions.patch",
      params: {
        key: sessionKey,
        spawnedBy: requesterInternalKey,
        ...(params.label ? { label: params.label } : {}),
      },
      timeoutMs: 10_000,
    });
    sessionCreated = true;
    const initializedSession = await initializeAcpSpawnRuntime({
      cfg,
      sessionKey,
      targetAgentId,
      runtimeMode,
      resumeSessionId: params.resumeSessionId,
      cwd: params.cwd,
    });
    initializedRuntime = initializedSession.runtimeCloseHandle;

    if (preparedBinding) {
      ({ binding } = await bindPreparedAcpThread({
        cfg,
        sessionKey,
        targetAgentId,
        label: params.label,
        preparedBinding,
        initializedRuntime: initializedSession,
      }));
    }
  } catch (err) {
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

  const deliveryPlan = resolveAcpSpawnBootstrapDeliveryPlan({
    spawnMode,
    requestThreadBinding,
    effectiveStreamToParent,
    requester: requesterState,
    binding,
  });
  const childIdem = crypto.randomUUID();
  let childRunId: string = childIdem;
  const streamLogPath =
    effectiveStreamToParent && parentSessionKey
      ? resolveAcpSpawnStreamLogPath({
          childSessionKey: sessionKey,
        })
      : undefined;
  let parentRelay: AcpSpawnParentRelayHandle | undefined;
  if (effectiveStreamToParent && parentSessionKey) {
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
        channel: deliveryPlan.channel,
        to: deliveryPlan.to,
        accountId: deliveryPlan.accountId,
        threadId: deliveryPlan.threadId,
        idempotencyKey: childIdem,
        deliver: deliveryPlan.useInlineDelivery,
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

  if (effectiveStreamToParent && parentSessionKey) {
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
