import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { formatThinkingLevels, normalizeThinkLevel } from "../auto-reply/thinking.js";
import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../config/agent-limits.js";
import { loadConfig } from "../config/config.js";
import { mergeSessionEntry, updateSessionStore } from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import {
  pruneLegacyStoreKeys,
  resolveGatewaySessionStoreTarget,
} from "../gateway/session-utils.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";
import {
  isValidAgentId,
  isCronSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import { resolveSubagentSpawnModelSelection } from "./model-selection.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
import {
  mapToolContextToSpawnedRunMetadata,
  normalizeSpawnedRunMetadata,
  resolveSpawnedWorkspaceInheritance,
} from "./spawned-context.js";
import { buildSubagentSystemPrompt, buildChildMessage } from "./subagent-announce.js";
import {
  decodeStrictBase64,
  materializeSubagentAttachments,
  type SubagentAttachmentReceiptFile,
} from "./subagent-attachments.js";
import { resolveSubagentCapabilities } from "./subagent-capabilities.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { countActiveRunsForSession, registerSubagentRun } from "./subagent-registry.js";
import { readStringParam } from "./tools/common.js";
import {
  FORK_SUBAGENT_FEATURE,
  FORK_BOILERPLATE_TAG,
} from "./fork-constants.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./tools/sessions-helpers.js";

export const SUBAGENT_SPAWN_MODES = ["run", "session"] as const;
export type SpawnSubagentMode = (typeof SUBAGENT_SPAWN_MODES)[number];
export const SUBAGENT_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
export type SpawnSubagentSandboxMode = (typeof SUBAGENT_SPAWN_SANDBOX_MODES)[number];

export { decodeStrictBase64 };

type SubagentSpawnDeps = {
  callGateway: typeof callGateway;
  getGlobalHookRunner: () => SubagentLifecycleHookRunner | null;
  loadConfig: typeof loadConfig;
  updateSessionStore: typeof updateSessionStore;
};

const defaultSubagentSpawnDeps: SubagentSpawnDeps = {
  callGateway,
  getGlobalHookRunner,
  loadConfig,
  updateSessionStore,
};

let subagentSpawnDeps: SubagentSpawnDeps = defaultSubagentSpawnDeps;

export type SpawnSubagentParams = {
  task: string;
  label?: string;
  agentId?: string;
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
  /**
   * Fork 模式参数
   * 当启用时，子代理继承父代理的完整上下文并共享 prompt cache
   */
  fork?: boolean;
  /**
   * Fork 模式下的子代理指令
   * 仅当 fork=true 时使用
   */
  forkDirective?: string;
  /**
   * 继承父消息历史（Phase 2）
   * 默认 true（fork 模式下）
   */
  inheritContext?: boolean;
  /**
   * 权限冒泡模式（Phase 3）
   * 子代理权限请求冒泡到父会话确认
   */
  permissionBubble?: boolean;
  /**
   * 工具继承（Phase 4）
   * 继承父代理的完整工具集
   */
  inheritTools?: boolean;
};

export type SpawnSubagentContext = {
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
  attachments?: {
    count: number;
    totalBytes: number;
    files: Array<{ name: string; bytes: number; sha256: string }>;
    relDir: string;
  };
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

async function updateSubagentSessionStore(
  storePath: string,
  mutator: Parameters<typeof updateSessionStore>[1],
) {
  return await subagentSpawnDeps.updateSessionStore(storePath, mutator);
}

async function callSubagentGateway(
  params: Parameters<typeof callGateway>[0],
): Promise<Awaited<ReturnType<typeof callGateway>>> {
  return await subagentSpawnDeps.callGateway(params);
}

function readGatewayRunId(response: Awaited<ReturnType<typeof callGateway>>): string | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const { runId } = response as { runId?: unknown };
  return typeof runId === "string" && runId ? runId : undefined;
}

function loadSubagentConfig() {
  return subagentSpawnDeps.loadConfig();
}

async function persistInitialChildSessionRuntimeModel(params: {
  cfg: ReturnType<typeof loadConfig>;
  childSessionKey: string;
  resolvedModel?: string;
}): Promise<string | undefined> {
  const { provider, model } = splitModelRef(params.resolvedModel);
  if (!model) {
    return undefined;
  }
  try {
    const target = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.childSessionKey,
    });
    await updateSubagentSessionStore(target.storePath, (store) => {
      pruneLegacyStoreKeys({
        store,
        canonicalKey: target.canonicalKey,
        candidates: target.storeKeys,
      });
      store[target.canonicalKey] = mergeSessionEntry(store[target.canonicalKey], {
        model,
        ...(provider ? { modelProvider: provider } : {}),
      });
    });
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : typeof err === "string" ? err : "error";
  }
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
    await callSubagentGateway({
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
  hookRunner: SubagentLifecycleHookRunner | null;
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

  // ========== Fork 模式检查（Phase 3）==========
  const forkRequested = params.fork === true;
  const forkEnabled = forkRequested && isForkSubagentEnabled();

  // 如果请求 fork 但功能未启用
  if (forkRequested && !isForkSubagentEnabled()) {
    return {
      status: "error",
      error: "Fork mode requires OPENCLAW_FORK_SUBAGENT=1 or agents.defaults.forkSubagent=true in config",
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
  const hookRunner = subagentSpawnDeps.getGlobalHookRunner();
  const cfg = loadSubagentConfig();

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
  if (callerDepth >= maxSpawnDepth) {
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

  const requesterAgentId = normalizeAgentId(
    ctx.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
  );
  const requireAgentId =
    resolveAgentConfig(cfg, requesterAgentId)?.subagents?.requireAgentId ??
    cfg.agents?.defaults?.subagents?.requireAgentId ??
    false;
  if (requireAgentId && !requestedAgentId?.trim()) {
    return {
      status: "forbidden",
      error:
        "sessions_spawn requires explicit agentId when requireAgentId is configured. Use agents_list to see allowed agent ids.",
    };
  }
  const targetAgentId = requestedAgentId ? normalizeAgentId(requestedAgentId) : requesterAgentId;
  if (targetAgentId !== requesterAgentId) {
    const allowAgents = resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ?? [];
    const allowAny = allowAgents.some((value) => value.trim() === "*");
    const normalizedTargetId = targetAgentId.toLowerCase();
    const allowSet = new Set(
      allowAgents
        .filter((value) => value.trim() && value.trim() !== "*")
        .map((value) => normalizeAgentId(value).toLowerCase()),
    );
    if (!allowAny && !allowSet.has(normalizedTargetId)) {
      const allowedText = allowSet.size > 0 ? Array.from(allowSet).join(", ") : "none";
      return {
        status: "forbidden",
        error: `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`,
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
      await callSubagentGateway({
        method: "sessions.patch",
        params: { key: childSessionKey, ...patch },
        timeoutMs: 10_000,
      });
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    }
  };

  const initialChildSessionPatch: Record<string, unknown> = {
    spawnDepth: childDepth,
    subagentRole: childCapabilities.role === "main" ? null : childCapabilities.role,
    subagentControlScope: childCapabilities.controlScope,
  };
  if (resolvedModel) {
    initialChildSessionPatch.model = resolvedModel;
  }
  if (thinkingOverride !== undefined) {
    initialChildSessionPatch.thinkingLevel = thinkingOverride === "off" ? null : thinkingOverride;
  }

  const initialPatchError = await patchChildSession(initialChildSessionPatch);
  if (initialPatchError) {
    return {
      status: "error",
      error: initialPatchError,
      childSessionKey,
    };
  }
  if (resolvedModel) {
    const runtimeModelPersistError = await persistInitialChildSessionRuntimeModel({
      cfg,
      childSessionKey,
      resolvedModel,
    });
    if (runtimeModelPersistError) {
      try {
        await callSubagentGateway({
          method: "sessions.delete",
          params: { key: childSessionKey, emitLifecycleHooks: false },
          timeoutMs: 10_000,
        });
      } catch {
        // Best-effort cleanup only.
      }
      return {
        status: "error",
        error: runtimeModelPersistError,
        childSessionKey,
      };
    }
    modelApplied = true;
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
        await callSubagentGateway({
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

  // ========== Fork 消息构建（Phase 3）==========
  // Fork 模式使用 buildForkedMessages 构建优化消息
  // 传统模式使用 childTaskMessage
  
  let finalTaskMessage: string = task;
  
  if (forkEnabled && params.forkDirective) {
    // Fork 模式：使用 buildChildMessage 构建指令
    // 注意：完整的 fork 消息构建需要父代理的 assistant message
    // 当前实现使用简化版本，仅注入 fork 指令格式
    
    finalTaskMessage = buildChildMessage(params.forkDirective);
    
    // Fork 模式下的系统提示调整
    // 子代理继承父系统提示，不需要额外的 subagent 上下文提示
    childSystemPrompt = ""; // 清空，让 fork 子代理使用继承的系统提示
  }

  const childTaskMessage = [
    forkEnabled 
      ? undefined // Fork 模式不添加 subagent 上下文提示
      : `[Subagent Context] You are running as a subagent (depth ${childDepth}/${maxSpawnDepth}). Results auto-announce to your requester; do not busy-poll for status.`,
    spawnMode === "session" && !forkEnabled
      ? "[Subagent Context] This subagent session is persistent and remains available for thread follow-up messages."
      : undefined,
    forkEnabled 
      ? finalTaskMessage // Fork 模式使用 buildChildMessage 输出
      : `[Subagent Task]: ${task}`,
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
    const response = await callSubagentGateway({
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
    const runId = readGatewayRunId(response);
    if (runId) {
      childRunId = runId;
    }
  } catch (err) {
    if (attachmentAbsDir) {
      try {
        await fs.rm(attachmentAbsDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
    let emitLifecycleHooks = false;
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
      emitLifecycleHooks = !endedHookEmitted;
    }
    // Always delete the provisional child session after a failed spawn attempt.
    // If we already emitted subagent_ended above, suppress a duplicate lifecycle hook.
    try {
      await callSubagentGateway({
        method: "sessions.delete",
        params: {
          key: childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks,
        },
        timeoutMs: 10_000,
      });
    } catch {
      // Best-effort only.
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
      await callSubagentGateway({
        method: "sessions.delete",
        params: {
          key: childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: threadBindingReady,
        },
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

  // Emit lifecycle event so the gateway can broadcast sessions.changed to SSE subscribers.
  emitSessionLifecycleEvent({
    sessionKey: childSessionKey,
    reason: "create",
    parentSessionKey: requesterInternalKey,
    label: label || undefined,
  });

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
    attachments: attachmentsReceipt,
  };
}

export const __testing = {
  setDepsForTest(overrides?: Partial<SubagentSpawnDeps>) {
    subagentSpawnDeps = overrides
      ? {
          ...defaultSubagentSpawnDeps,
          ...overrides,
        }
      : defaultSubagentSpawnDeps;
  },
};

/**
 * 检查是否启用了 Fork 子代理功能
 *
 * 当启用时：
 * - 省略 subagent_type 会触发隐式 fork
 * - 子代理继承父代理的完整对话上下文和系统提示
 * - 所有子代理在后台异步运行
 */
export function isForkSubagentEnabled(): boolean {
  // 检查 Feature Flag 是否启用
  if (process.env.OPENCLAW_FORK_SUBAGENT === "1") {
    return true;
  }
  // 检查配置
  const cfg = loadConfig();
  if (cfg?.agents?.defaults?.forkSubagent === true) {
    return true;
  }
  return false;
}

/**
 * 检查是否在 Fork 子代理中
 * 通过检测对话历史中是否存在 fork boilerplate tag
 */
export function isInForkChild(messages: Array<{ type?: string; message?: { content?: unknown } }>): boolean {
  return messages.some((m) => {
    if (m.type !== "user") return false;
    const content = m.message?.content;
    if (!Array.isArray(content)) return false;
    return content.some(
      (block) =>
        block &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string" &&
        block.text.includes(`<${FORK_BOILERPLATE_TAG}>`),
    );
  });
}

/**
 * 检查消息中是否包含 fork 相关的 boilerplate
 */
export function hasForkBoilerplate(text: string): boolean {
  return text.includes(`<${FORK_BOILERPLATE_TAG}>`);
}
