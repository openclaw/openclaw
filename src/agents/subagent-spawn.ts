import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { formatThinkingLevels, normalizeThinkLevel } from "../auto-reply/thinking.js";
import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../config/agent-limits.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  isValidAgentId,
  isCronSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import { resolveSubagentSpawnModelSelection } from "./model-selection.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
import {
  buildSessionsSpawnDedupKey,
  getSpawnDedupMinuteEpoch,
  logSessionsSpawnDedupHit,
  peekSessionsSpawnDedup,
  recordSessionsSpawnDedup,
  SESSIONS_SPAWN_DEDUP_TTL_MS,
} from "./sessions-spawn-dedup.js";
import {
  mapToolContextToSpawnedRunMetadata,
  normalizeSpawnedRunMetadata,
  resolveSpawnedWorkspaceInheritance,
} from "./spawned-context.js";
import { buildSubagentSystemPrompt } from "./subagent-announce.js";
import {
  decodeStrictBase64,
  materializeSubagentAttachments,
  type SubagentAttachmentReceiptFile,
} from "./subagent-attachments.js";
import { resolveSubagentCapabilities } from "./subagent-capabilities.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { countActiveRunsForSession, registerSubagentRun } from "./subagent-registry.js";
import {
  SUBAGENT_SPAWN_MODES,
  SUBAGENT_SPAWN_SANDBOX_MODES,
  type SpawnSubagentMode,
  type SpawnSubagentSandboxMode,
} from "./subagent-spawn-modes.js";
import { resolveSubagentTargetReadiness } from "./subagent-target-readiness.js";
import { readStringParam } from "./tools/common.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./tools/sessions-helpers.js";
import {
  isUniversalSubagentTarget,
  resolveRequesterSubagentAllowlist,
} from "./universal-targets.js";
export {
  SUBAGENT_SPAWN_MODES,
  SUBAGENT_SPAWN_SANDBOX_MODES,
  type SpawnSubagentMode,
  type SpawnSubagentSandboxMode,
} from "./subagent-spawn-modes.js";

export { decodeStrictBase64 };

export type SpawnSubagentParams = {
  task: string;
  label?: string;
  agentId?: string;
  teamId?: string;
  capability?: string;
  role?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  thread?: boolean;
  mode?: SpawnSubagentMode;
  cleanup?: "delete" | "keep";
  sandbox?: SpawnSubagentSandboxMode;
  expectsCompletionMessage?: boolean;
  attachments?: Array<{
    name: string;
    content: string;
    encoding?: "utf8" | "base64";
    mimeType?: string;
  }>;
  attachMountPath?: string;
};

export type SpawnSubagentContext = {
  cfg?: OpenClawConfig;
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  requesterAgentIdOverride?: string;
  /** Explicit workspace directory for subagent to inherit (optional). */
  workspaceDir?: string;
};

export const SUBAGENT_SPAWN_ACCEPTED_NOTE =
  "Auto-announce is push-based. After spawning children, do NOT call sessions_list, sessions_history, exec sleep, or any polling tool. Wait for completion events to arrive as user messages, track expected child session keys, and only send your final answer after ALL expected completions arrive. If a child completion event arrives AFTER your final answer, reply ONLY with NO_REPLY.";
export const SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE =
  "thread-bound session stays active after this task; continue in-thread for follow-ups.";

export type SpawnSubagentResult = {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  runId?: string;
  mode?: SpawnSubagentMode;
  note?: string;
  modelApplied?: boolean;
  error?: string;
  resolvedAgentId?: string;
  teamId?: string | null;
  capability?: string | null;
  roleAliasUsed?: boolean;
  attachments?: {
    count: number;
    totalBytes: number;
    files: Array<{ name: string; bytes: number; sha256: string }>;
    relDir: string;
  };
  /** True when this response reused a child from a recent identical spawn (see sessions-spawn-dedup). */
  deduplicated?: boolean;
};

export function splitModelRef(ref?: string) {
  if (!ref) {
    return { provider: undefined, model: undefined };
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    return { provider: undefined, model: undefined };
  }
  const [provider, model] = trimmed.split("/", 2);
  if (model) {
    return { provider, model };
  }
  return { provider: undefined, model: trimmed };
}

function sanitizeMountPathHint(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  // Prevent prompt injection via control/newline characters in system prompt hints.
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\u0000-\u001F\u007F\u0085\u2028\u2029]/.test(trimmed)) {
    return undefined;
  }
  if (!/^[A-Za-z0-9._\-/:]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

async function cleanupProvisionalSession(
  childSessionKey: string,
  options?: {
    emitLifecycleHooks?: boolean;
    deleteTranscript?: boolean;
  },
): Promise<void> {
  try {
    await callGateway({
      method: "sessions.delete",
      params: {
        key: childSessionKey,
        emitLifecycleHooks: options?.emitLifecycleHooks === true,
        deleteTranscript: options?.deleteTranscript === true,
      },
      timeoutMs: 10_000,
    });
  } catch {
    // Best-effort cleanup only.
  }
}

async function cleanupFailedSpawnBeforeAgentStart(params: {
  childSessionKey: string;
  attachmentAbsDir?: string;
  emitLifecycleHooks?: boolean;
  deleteTranscript?: boolean;
}): Promise<void> {
  if (params.attachmentAbsDir) {
    try {
      await fs.rm(params.attachmentAbsDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
  await cleanupProvisionalSession(params.childSessionKey, {
    emitLifecycleHooks: params.emitLifecycleHooks,
    deleteTranscript: params.deleteTranscript,
  });
}

function resolveSpawnMode(params: {
  requestedMode?: SpawnSubagentMode;
  threadRequested: boolean;
}): SpawnSubagentMode {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  // Thread-bound spawns should default to persistent sessions.
  return params.threadRequested ? "session" : "run";
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

async function ensureThreadBindingForSubagentSpawn(params: {
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  childSessionKey: string;
  agentId: string;
  label?: string;
  mode: SpawnSubagentMode;
  requesterSessionKey?: string;
  requester: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
}): Promise<{ status: "ok" } | { status: "error"; error: string }> {
  const hookRunner = params.hookRunner;
  if (!hookRunner?.hasHooks("subagent_spawning")) {
    return {
      status: "error",
      error:
        "thread=true is unavailable because no channel plugin registered subagent_spawning hooks.",
    };
  }

  try {
    const result = await hookRunner.runSubagentSpawning(
      {
        childSessionKey: params.childSessionKey,
        agentId: params.agentId,
        label: params.label,
        mode: params.mode,
        requester: params.requester,
        threadRequested: true,
      },
      {
        childSessionKey: params.childSessionKey,
        requesterSessionKey: params.requesterSessionKey,
      },
    );
    if (result?.status === "error") {
      const error = result.error.trim();
      return {
        status: "error",
        error: error || "Failed to prepare thread binding for this subagent session.",
      };
    }
    if (result?.status !== "ok" || !result.threadBindingReady) {
      return {
        status: "error",
        error:
          "Unable to create or bind a thread for this subagent session. Session mode is unavailable for this target.",
      };
    }
    return { status: "ok" };
  } catch (err) {
    return {
      status: "error",
      error: `Thread bind failed: ${summarizeError(err)}`,
    };
  }
}

export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext,
): Promise<SpawnSubagentResult> {
  const task = params.task;
  const label = params.label?.trim() || "";
  const requestedAgentId = params.agentId?.trim();
  const requestedTeamId = params.teamId?.trim();
  const requestedCapability = params.capability?.trim();
  const requestedRole = params.role?.trim();

  if (requestedAgentId && (requestedTeamId || requestedCapability || requestedRole)) {
    return {
      status: "error",
      error: "agentId cannot be combined with teamId, capability, or role",
    };
  }
  if ((requestedCapability || requestedRole) && !requestedTeamId) {
    return {
      status: "error",
      error: "capability/role requires teamId",
    };
  }
  if (
    requestedCapability &&
    requestedRole &&
    requestedCapability.toLowerCase() !== requestedRole.toLowerCase()
  ) {
    return {
      status: "error",
      error: "capability and role must match when both are provided",
    };
  }

  // Reject malformed agentId before normalizeAgentId can mangle it.
  // Without this gate, error-message strings like "Agent not found: xyz" pass
  // through normalizeAgentId and become "agent-not-found--xyz", which later
  // creates ghost workspace directories and triggers cascading cron loops (#31311).
  if (requestedAgentId && !isValidAgentId(requestedAgentId)) {
    return {
      status: "error",
      error: `Invalid agentId "${requestedAgentId}". Agent IDs must match [a-z0-9][a-z0-9_-]{0,63}. Use agents_list to discover valid targets.`,
    };
  }
  const modelOverride = params.model;
  const thinkingOverrideRaw = params.thinking;
  const requestThreadBinding = params.thread === true;
  const sandboxMode = params.sandbox === "require" ? "require" : "inherit";
  const spawnMode = resolveSpawnMode({
    requestedMode: params.mode,
    threadRequested: requestThreadBinding,
  });
  if (spawnMode === "session" && !requestThreadBinding) {
    return {
      status: "error",
      error: 'mode="session" requires thread=true so the subagent can stay bound to a thread.',
    };
  }
  const cleanup =
    spawnMode === "session"
      ? "keep"
      : params.cleanup === "keep" || params.cleanup === "delete"
        ? params.cleanup
        : "keep";
  const expectsCompletionMessage = params.expectsCompletionMessage !== false;
  const requesterOrigin = normalizeDeliveryContext({
    channel: ctx.agentChannel,
    accountId: ctx.agentAccountId,
    to: ctx.agentTo,
    threadId: ctx.agentThreadId,
  });
  const hookRunner = getGlobalHookRunner();
  const cfg = ctx.cfg ?? loadConfig();

  // When agent omits runTimeoutSeconds, use the config default.
  // Falls back to 0 (no timeout) if config key is also unset,
  // preserving current behavior for existing deployments.
  const cfgSubagentTimeout =
    typeof cfg?.agents?.defaults?.subagents?.runTimeoutSeconds === "number" &&
    Number.isFinite(cfg.agents.defaults.subagents.runTimeoutSeconds)
      ? Math.max(0, Math.floor(cfg.agents.defaults.subagents.runTimeoutSeconds))
      : 0;
  const runTimeoutSeconds =
    typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
      ? Math.max(0, Math.floor(params.runTimeoutSeconds))
      : cfgSubagentTimeout;
  let modelApplied = false;
  let threadBindingReady = false;
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const requesterSessionKey = ctx.agentSessionKey;
  const requesterInternalKey = requesterSessionKey
    ? resolveInternalSessionKey({
        key: requesterSessionKey,
        alias,
        mainKey,
      })
    : alias;
  const requesterDisplayKey = resolveDisplaySessionKey({
    key: requesterInternalKey,
    alias,
    mainKey,
  });

  const callerDepth = getSubagentDepthFromSessionStore(requesterInternalKey, { cfg });
  const maxSpawnDepth =
    cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  const requesterAgentId = normalizeAgentId(
    ctx.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
  );
  let resolvedTeamId: string | null = null;
  let resolvedCapability: string | null = null;
  let roleAliasUsed = false;
  let targetAgentId = requestedAgentId ? normalizeAgentId(requestedAgentId) : requesterAgentId;
  if (!requestedAgentId && requestedTeamId) {
    try {
      const { resolveSpecialistTarget } =
        await import("../operator-control/specialist-resolver.runtime.js");
      const resolved = resolveSpecialistTarget({
        requesterId: requesterAgentId,
        teamId: requestedTeamId,
        capability: requestedCapability,
        role: requestedRole,
        runtimePreference: "subagent",
      });
      targetAgentId = normalizeAgentId(resolved.identityId);
      resolvedTeamId = resolved.teamId;
      resolvedCapability = resolved.capability;
      roleAliasUsed = resolved.roleAliasUsed;
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const universalTarget =
    targetAgentId !== requesterAgentId && isUniversalSubagentTarget(targetAgentId);
  if (callerDepth >= maxSpawnDepth && !universalTarget) {
    return {
      status: "forbidden",
      error: `sessions_spawn is not allowed at this depth (current depth: ${callerDepth}, max: ${maxSpawnDepth})`,
    };
  }

  const maxChildren = cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5;
  const activeChildren = countActiveRunsForSession(requesterInternalKey);
  if (activeChildren >= maxChildren) {
    return {
      status: "forbidden",
      error: `sessions_spawn has reached max active children for this session (${activeChildren}/${maxChildren})`,
    };
  }

  if (targetAgentId !== requesterAgentId) {
    const { allowAny, allowSet, explicitAllowSet } = resolveRequesterSubagentAllowlist({
      cfg,
      requesterAgentId,
    });
    const normalizedTargetId = targetAgentId.toLowerCase();
    const normalizedAllowSet = new Set(Array.from(allowSet, (value) => value.toLowerCase()));
    if (!allowAny && !normalizedAllowSet.has(normalizedTargetId)) {
      const allowedText =
        normalizedAllowSet.size > 0 ? Array.from(normalizedAllowSet).join(", ") : "none";
      return {
        status: "forbidden",
        error: `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`,
      };
    }
    const readiness = resolveSubagentTargetReadiness({
      cfg,
      requesterAgentId,
      targetAgentId,
      classifyStaleAllowlist: explicitAllowSet.has(normalizedTargetId),
    });
    if (readiness.status !== "ready") {
      const reason = readiness.reasons[0] ?? "target agent is not ready";
      if (readiness.status === "missing_config") {
        return {
          status: "error",
          error: `agentId "${targetAgentId}" is not configured as a runtime agent with an explicit workspace. ${reason}.`,
        };
      }
      if (readiness.status === "missing_workspace") {
        return {
          status: "error",
          error: `agentId "${targetAgentId}" is not workspace-backed for sessions_spawn. ${reason}.`,
        };
      }
      return {
        status: "error",
        error: `agentId "${targetAgentId}" is a stale allowlist entry. ${reason}.`,
      };
    }
  }

  const trimmedTask = task.trim();
  const shouldAttemptSpawnDedup =
    trimmedTask.length > 0 &&
    !(params.attachments && params.attachments.length > 0) &&
    !sanitizeMountPathHint(params.attachMountPath);
  let subagentSpawnDedupKey: string | undefined;
  if (shouldAttemptSpawnDedup) {
    const minuteEpoch = getSpawnDedupMinuteEpoch();
    const dedupVariant = [
      "subagent",
      `mode:${spawnMode}`,
      `thread:${requestThreadBinding}`,
      `sandbox:${sandboxMode}`,
      `label:${label}`,
    ].join("|");
    subagentSpawnDedupKey = buildSessionsSpawnDedupKey({
      requesterInternalKey,
      targetAgentId,
      objectiveText: trimmedTask,
      minuteEpoch,
      variant: dedupVariant,
    });
    const dedupHit = peekSessionsSpawnDedup({ dedupKey: subagentSpawnDedupKey });
    if (dedupHit) {
      logSessionsSpawnDedupHit({
        targetAgentId,
        requesterInternalKey,
        childSessionKey: dedupHit.childSessionKey,
        runId: dedupHit.runId,
        minuteEpoch,
        objectiveCharCount: trimmedTask.length,
      });
      const isCronSession = isCronSessionKey(ctx.agentSessionKey);
      const dedupSuffix = `(deduplicated: reused spawn from the last ${SESSIONS_SPAWN_DEDUP_TTL_MS / 1000}s)`;
      const note =
        spawnMode === "session"
          ? `${SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE} ${dedupSuffix}`
          : isCronSession
            ? dedupSuffix
            : `${SUBAGENT_SPAWN_ACCEPTED_NOTE} ${dedupSuffix}`;
      return {
        status: "accepted",
        childSessionKey: dedupHit.childSessionKey,
        runId: dedupHit.runId,
        mode: spawnMode,
        note,
        deduplicated: true,
        resolvedAgentId: targetAgentId,
        teamId: resolvedTeamId,
        capability: resolvedCapability,
        roleAliasUsed,
      };
    }
  }

  const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
  const requesterRuntime = resolveSandboxRuntimeStatus({
    cfg,
    sessionKey: requesterInternalKey,
  });
  const childRuntime = resolveSandboxRuntimeStatus({
    cfg,
    sessionKey: childSessionKey,
  });
  if (!childRuntime.sandboxed && (requesterRuntime.sandboxed || sandboxMode === "require")) {
    if (requesterRuntime.sandboxed) {
      return {
        status: "forbidden",
        error:
          "Sandboxed sessions cannot spawn unsandboxed subagents. Set a sandboxed target agent or use the same agent runtime.",
      };
    }
    return {
      status: "forbidden",
      error:
        'sessions_spawn sandbox="require" needs a sandboxed target runtime. Pick a sandboxed agentId or use sandbox="inherit".',
    };
  }
  const childDepth = callerDepth + 1;
  const spawnedByKey = requesterInternalKey;
  const childCapabilities = resolveSubagentCapabilities({
    depth: childDepth,
    maxSpawnDepth,
  });
  const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
  const resolvedModel = resolveSubagentSpawnModelSelection({
    cfg,
    agentId: targetAgentId,
    modelOverride,
  });

  const resolvedThinkingDefaultRaw =
    readStringParam(targetAgentConfig?.subagents ?? {}, "thinking") ??
    readStringParam(cfg.agents?.defaults?.subagents ?? {}, "thinking");

  let thinkingOverride: string | undefined;
  const thinkingCandidateRaw = thinkingOverrideRaw || resolvedThinkingDefaultRaw;
  if (thinkingCandidateRaw) {
    const normalized = normalizeThinkLevel(thinkingCandidateRaw);
    if (!normalized) {
      const { provider, model } = splitModelRef(resolvedModel);
      const hint = formatThinkingLevels(provider, model);
      return {
        status: "error",
        error: `Invalid thinking level "${thinkingCandidateRaw}". Use one of: ${hint}.`,
      };
    }
    thinkingOverride = normalized;
  }
  const patchChildSession = async (patch: Record<string, unknown>): Promise<string | undefined> => {
    try {
      await callGateway({
        method: "sessions.patch",
        params: { key: childSessionKey, ...patch },
        timeoutMs: 10_000,
      });
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    }
  };

  const spawnDepthPatchError = await patchChildSession({
    spawnDepth: childDepth,
    subagentRole: childCapabilities.role === "main" ? null : childCapabilities.role,
    subagentControlScope: childCapabilities.controlScope,
  });
  if (spawnDepthPatchError) {
    return {
      status: "error",
      error: spawnDepthPatchError,
      childSessionKey,
    };
  }

  if (resolvedModel) {
    const modelPatchError = await patchChildSession({ model: resolvedModel });
    if (modelPatchError) {
      return {
        status: "error",
        error: modelPatchError,
        childSessionKey,
      };
    }
    modelApplied = true;
  }
  if (thinkingOverride !== undefined) {
    const thinkingPatchError = await patchChildSession({
      thinkingLevel: thinkingOverride === "off" ? null : thinkingOverride,
    });
    if (thinkingPatchError) {
      return {
        status: "error",
        error: thinkingPatchError,
        childSessionKey,
      };
    }
  }
  if (requestThreadBinding) {
    const bindResult = await ensureThreadBindingForSubagentSpawn({
      hookRunner,
      childSessionKey,
      agentId: targetAgentId,
      label: label || undefined,
      mode: spawnMode,
      requesterSessionKey: requesterInternalKey,
      requester: {
        channel: requesterOrigin?.channel,
        accountId: requesterOrigin?.accountId,
        to: requesterOrigin?.to,
        threadId: requesterOrigin?.threadId,
      },
    });
    if (bindResult.status === "error") {
      try {
        await callGateway({
          method: "sessions.delete",
          params: { key: childSessionKey, emitLifecycleHooks: false },
          timeoutMs: 10_000,
        });
      } catch {
        // Best-effort cleanup only.
      }
      return {
        status: "error",
        error: bindResult.error,
        childSessionKey,
      };
    }
    threadBindingReady = true;
  }
  const mountPathHint = sanitizeMountPathHint(params.attachMountPath);

  let childSystemPrompt = buildSubagentSystemPrompt({
    requesterSessionKey,
    requesterOrigin,
    childSessionKey,
    label: label || undefined,
    task,
    acpEnabled: cfg.acp?.enabled !== false && !childRuntime.sandboxed,
    childDepth,
    maxSpawnDepth,
  });

  let retainOnSessionKeep = false;
  let attachmentsReceipt:
    | {
        count: number;
        totalBytes: number;
        files: SubagentAttachmentReceiptFile[];
        relDir: string;
      }
    | undefined;
  let attachmentAbsDir: string | undefined;
  let attachmentRootDir: string | undefined;
  const materializedAttachments = await materializeSubagentAttachments({
    config: cfg,
    targetAgentId,
    attachments: params.attachments,
    mountPathHint,
  });
  if (materializedAttachments && materializedAttachments.status !== "ok") {
    await cleanupProvisionalSession(childSessionKey, {
      emitLifecycleHooks: threadBindingReady,
      deleteTranscript: true,
    });
    return {
      status: materializedAttachments.status,
      error: materializedAttachments.error,
    };
  }
  if (materializedAttachments?.status === "ok") {
    retainOnSessionKeep = materializedAttachments.retainOnSessionKeep;
    attachmentsReceipt = materializedAttachments.receipt;
    attachmentAbsDir = materializedAttachments.absDir;
    attachmentRootDir = materializedAttachments.rootDir;
    childSystemPrompt = `${childSystemPrompt}\n\n${materializedAttachments.systemPromptSuffix}`;
  }

  const childTaskMessage = [
    `[Subagent Context] You are running as a subagent (depth ${childDepth}/${maxSpawnDepth}). Results auto-announce to your requester; do not busy-poll for status.`,
    spawnMode === "session"
      ? "[Subagent Context] This subagent session is persistent and remains available for thread follow-up messages."
      : undefined,
    `[Subagent Task]: ${task}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");

  const toolSpawnMetadata = mapToolContextToSpawnedRunMetadata({
    agentGroupId: ctx.agentGroupId,
    agentGroupChannel: ctx.agentGroupChannel,
    agentGroupSpace: ctx.agentGroupSpace,
    workspaceDir: ctx.workspaceDir,
  });
  const spawnedMetadata = normalizeSpawnedRunMetadata({
    spawnedBy: spawnedByKey,
    ...toolSpawnMetadata,
    workspaceDir: resolveSpawnedWorkspaceInheritance({
      config: cfg,
      targetAgentId,
      // For cross-agent spawns, ignore the caller's inherited workspace;
      // let targetAgentId resolve the correct workspace instead.
      explicitWorkspaceDir:
        targetAgentId !== requesterAgentId ? undefined : toolSpawnMetadata.workspaceDir,
    }),
  });
  const spawnLineagePatchError = await patchChildSession({
    spawnedBy: spawnedByKey,
    ...(spawnedMetadata.workspaceDir ? { spawnedWorkspaceDir: spawnedMetadata.workspaceDir } : {}),
  });
  if (spawnLineagePatchError) {
    await cleanupFailedSpawnBeforeAgentStart({
      childSessionKey,
      attachmentAbsDir,
      emitLifecycleHooks: threadBindingReady,
      deleteTranscript: true,
    });
    return {
      status: "error",
      error: spawnLineagePatchError,
      childSessionKey,
    };
  }

  const childIdem = crypto.randomUUID();
  let childRunId: string = childIdem;
  try {
    const {
      spawnedBy: _spawnedBy,
      workspaceDir: _workspaceDir,
      ...publicSpawnedMetadata
    } = spawnedMetadata;
    const response = await callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: childTaskMessage,
        sessionKey: childSessionKey,
        channel: requesterOrigin?.channel,
        to: requesterOrigin?.to ?? undefined,
        accountId: requesterOrigin?.accountId ?? undefined,
        threadId: requesterOrigin?.threadId != null ? String(requesterOrigin.threadId) : undefined,
        idempotencyKey: childIdem,
        deliver: false,
        lane: AGENT_LANE_SUBAGENT,
        extraSystemPrompt: childSystemPrompt,
        thinking: thinkingOverride,
        timeout: runTimeoutSeconds,
        label: label || undefined,
        ...publicSpawnedMetadata,
      },
      timeoutMs: 10_000,
    });
    if (typeof response?.runId === "string" && response.runId) {
      childRunId = response.runId;
    }
  } catch (err) {
    if (attachmentAbsDir) {
      try {
        await fs.rm(attachmentAbsDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
    if (threadBindingReady) {
      const hasEndedHook = hookRunner?.hasHooks("subagent_ended") === true;
      let endedHookEmitted = false;
      if (hasEndedHook) {
        try {
          await hookRunner?.runSubagentEnded(
            {
              targetSessionKey: childSessionKey,
              targetKind: "subagent",
              reason: "spawn-failed",
              sendFarewell: true,
              accountId: requesterOrigin?.accountId,
              runId: childRunId,
              outcome: "error",
              error: "Session failed to start",
            },
            {
              runId: childRunId,
              childSessionKey,
              requesterSessionKey: requesterInternalKey,
            },
          );
          endedHookEmitted = true;
        } catch {
          // Spawn should still return an actionable error even if cleanup hooks fail.
        }
      }
      // Always delete the provisional child session after a failed spawn attempt.
      // If we already emitted subagent_ended above, suppress a duplicate lifecycle hook.
      try {
        await callGateway({
          method: "sessions.delete",
          params: {
            key: childSessionKey,
            deleteTranscript: true,
            emitLifecycleHooks: !endedHookEmitted,
          },
          timeoutMs: 10_000,
        });
      } catch {
        // Best-effort only.
      }
    }
    const messageText = summarizeError(err);
    return {
      status: "error",
      error: messageText,
      childSessionKey,
      runId: childRunId,
    };
  }

  try {
    registerSubagentRun({
      runId: childRunId,
      childSessionKey,
      controllerSessionKey: requesterInternalKey,
      requesterSessionKey: requesterInternalKey,
      requesterOrigin,
      requesterDisplayKey,
      task,
      cleanup,
      label: label || undefined,
      model: resolvedModel,
      workspaceDir: spawnedMetadata.workspaceDir,
      runTimeoutSeconds,
      expectsCompletionMessage,
      spawnMode,
      attachmentsDir: attachmentAbsDir,
      attachmentsRootDir: attachmentRootDir,
      retainAttachmentsOnKeep: retainOnSessionKeep,
      resolvedAgentId: targetAgentId,
      resolvedTeamId: resolvedTeamId,
      resolvedCapability: resolvedCapability,
      roleAliasUsed,
    });
  } catch (err) {
    if (attachmentAbsDir) {
      try {
        await fs.rm(attachmentAbsDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
    try {
      await callGateway({
        method: "sessions.delete",
        params: { key: childSessionKey, deleteTranscript: true, emitLifecycleHooks: false },
        timeoutMs: 10_000,
      });
    } catch {
      // Best-effort cleanup only.
    }
    return {
      status: "error",
      error: `Failed to register subagent run: ${summarizeError(err)}`,
      childSessionKey,
      runId: childRunId,
    };
  }

  if (hookRunner?.hasHooks("subagent_spawned")) {
    try {
      await hookRunner.runSubagentSpawned(
        {
          runId: childRunId,
          childSessionKey,
          agentId: targetAgentId,
          label: label || undefined,
          requester: {
            channel: requesterOrigin?.channel,
            accountId: requesterOrigin?.accountId,
            to: requesterOrigin?.to,
            threadId: requesterOrigin?.threadId,
          },
          threadRequested: requestThreadBinding,
          mode: spawnMode,
        },
        {
          runId: childRunId,
          childSessionKey,
          requesterSessionKey: requesterInternalKey,
        },
      );
    } catch {
      // Spawn should still return accepted if spawn lifecycle hooks fail.
    }
  }

  if (subagentSpawnDedupKey) {
    recordSessionsSpawnDedup({
      dedupKey: subagentSpawnDedupKey,
      childSessionKey,
      runId: childRunId,
    });
  }

  // Check if we're in a cron isolated session - don't add "do not poll" note
  // because cron sessions end immediately after the agent produces a response,
  // so the agent needs to wait for subagent results to keep the turn alive.
  const isCronSession = isCronSessionKey(ctx.agentSessionKey);
  const note =
    spawnMode === "session"
      ? SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE
      : isCronSession
        ? undefined
        : SUBAGENT_SPAWN_ACCEPTED_NOTE;

  return {
    status: "accepted",
    childSessionKey,
    runId: childRunId,
    mode: spawnMode,
    note,
    modelApplied: resolvedModel ? modelApplied : undefined,
    resolvedAgentId: targetAgentId,
    teamId: resolvedTeamId,
    capability: resolvedCapability,
    roleAliasUsed,
    attachments: attachmentsReceipt,
  };
}
