import crypto from "node:crypto";
import { formatThinkingLevels, normalizeThinkLevel } from "../auto-reply/thinking.js";
import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { resolveAgentConfig } from "./agent-scope.js";
import {
  resolveContextScripts,
  executeContextScripts,
  type ContextScriptEntry,
} from "./context-scripts.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import { resolveSubagentSpawnModelSelection } from "./model-selection.js";
import { buildSubagentSystemPrompt } from "./subagent-announce.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { countActiveRunsForSession, registerSubagentRun } from "./subagent-registry.js";
import { readStringParam } from "./tools/common.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./tools/sessions-helpers.js";

export type SpawnSubagentParams = {
  task: string;
  label?: string;
  agentId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  cleanup?: "delete" | "keep";
  expectsCompletionMessage?: boolean;
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
};

export const SUBAGENT_SPAWN_ACCEPTED_NOTE =
  "auto-announces on completion, do not poll/sleep. The response will be sent back as an agent message.";

export type SpawnSubagentResult = {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  runId?: string;
  note?: string;
  modelApplied?: boolean;
  error?: string;
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

export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext,
): Promise<SpawnSubagentResult> {
  const task = params.task;
  const label = params.label?.trim() || "";
  const requestedAgentId = params.agentId;
  const modelOverride = params.model;
  const thinkingOverrideRaw = params.thinking;
  const cleanup =
    params.cleanup === "keep" || params.cleanup === "delete" ? params.cleanup : "keep";
  const requesterOrigin = normalizeDeliveryContext({
    channel: ctx.agentChannel,
    accountId: ctx.agentAccountId,
    to: ctx.agentTo,
    threadId: ctx.agentThreadId,
  });
  const runTimeoutSeconds =
    typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
      ? Math.max(0, Math.floor(params.runTimeoutSeconds))
      : 0;
  let modelApplied = false;

  const cfg = loadConfig();
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
  const maxSpawnDepth = cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? 1;
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
  let initialTargetAgentId = requestedAgentId
    ? normalizeAgentId(requestedAgentId)
    : requesterAgentId;

  // --- Context Scripts: resolve and execute BEFORE allowlist check ---
  // This allows scripts to override the targetAgentId (e.g. dalta → patron)
  let resolvedTask = task;
  {
    const defaultSubagents = cfg.agents?.defaults?.subagents as
      | (Record<string, unknown> & { contextScripts?: { run?: ContextScriptEntry[] } })
      | undefined;
    const defaultContextScripts: ContextScriptEntry[] = defaultSubagents?.contextScripts?.run ?? [];
    const initialTargetConfig = resolveAgentConfig(cfg, initialTargetAgentId);
    const agentSubagents = (initialTargetConfig ?? resolveAgentConfig(cfg, requesterAgentId))
      ?.subagents as
      | (Record<string, unknown> & {
          contextScripts?: { run?: ContextScriptEntry[]; ignore?: string[] };
        })
      | undefined;
    const agentContextScripts: ContextScriptEntry[] = agentSubagents?.contextScripts?.run ?? [];
    const agentIgnoreScripts: string[] = agentSubagents?.contextScripts?.ignore ?? [];

    if (defaultContextScripts.length > 0 || agentContextScripts.length > 0) {
      try {
        const scripts = resolveContextScripts(
          defaultContextScripts,
          agentContextScripts,
          agentIgnoreScripts,
        );
        if (scripts.length > 0) {
          const spawnVariables: Record<string, unknown> = {
            targetAgentId: initialTargetAgentId,
            task,
            label,
            requesterAgentId,
            requesterSessionKey,
            cleanup,
            cfg,
          };
          const { prepend, append, agentIdOverride } = await executeContextScripts(
            scripts,
            spawnVariables,
            (candidateId) => resolveAgentConfig(cfg, normalizeAgentId(candidateId)) != null,
          );
          if (prepend || append) {
            resolvedTask = [prepend, task, append].filter(Boolean).join("\n\n");
          }
          if (agentIdOverride) {
            initialTargetAgentId = normalizeAgentId(agentIdOverride);
          }
        }
      } catch (err) {
        console.warn(
          `[context-scripts] Error running context scripts: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  // --- End Context Scripts ---

  const targetAgentId = initialTargetAgentId;
  const originalRequestedId = requestedAgentId
    ? normalizeAgentId(requestedAgentId)
    : requesterAgentId;

  // Check allowlist against BOTH the original requested ID and the final overridden ID.
  // This prevents a context script from silently redirecting to a disallowed agent.
  const idsToCheck = new Set(
    [originalRequestedId, targetAgentId]
      .filter((id) => id !== requesterAgentId)
      .map((id) => id.toLowerCase()),
  );
  if (idsToCheck.size > 0) {
    const allowAgents = resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ?? [];
    const allowAny = allowAgents.some((value) => value.trim() === "*");
    const allowSet = new Set(
      allowAgents
        .filter((value) => value.trim() && value.trim() !== "*")
        .map((value) => normalizeAgentId(value).toLowerCase()),
    );
    const disallowed = [...idsToCheck].find((id) => !allowAny && !allowSet.has(id));
    if (disallowed) {
      const allowedText = allowAny
        ? "*"
        : allowSet.size > 0
          ? Array.from(allowSet).join(", ")
          : "none";
      return {
        status: "forbidden",
        error: `agentId "${disallowed}" is not allowed for sessions_spawn (allowed: ${allowedText})`,
      };
    }
  }
  const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
  const childDepth = callerDepth + 1;
  const spawnedByKey = requesterInternalKey;
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
  try {
    await callGateway({
      method: "sessions.patch",
      params: { key: childSessionKey, spawnDepth: childDepth },
      timeoutMs: 10_000,
    });
  } catch (err) {
    const messageText =
      err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    return {
      status: "error",
      error: messageText,
      childSessionKey,
    };
  }

  if (resolvedModel) {
    try {
      await callGateway({
        method: "sessions.patch",
        params: { key: childSessionKey, model: resolvedModel },
        timeoutMs: 10_000,
      });
      modelApplied = true;
    } catch (err) {
      const messageText =
        err instanceof Error ? err.message : typeof err === "string" ? err : "error";
      return {
        status: "error",
        error: messageText,
        childSessionKey,
      };
    }
  }
  if (thinkingOverride !== undefined) {
    try {
      await callGateway({
        method: "sessions.patch",
        params: {
          key: childSessionKey,
          thinkingLevel: thinkingOverride === "off" ? null : thinkingOverride,
        },
        timeoutMs: 10_000,
      });
    } catch (err) {
      const messageText =
        err instanceof Error ? err.message : typeof err === "string" ? err : "error";
      return {
        status: "error",
        error: messageText,
        childSessionKey,
      };
    }
  }
  const childSystemPrompt = buildSubagentSystemPrompt({
    requesterSessionKey,
    requesterOrigin,
    childSessionKey,
    label: label || undefined,
    task: resolvedTask,
    childDepth,
    maxSpawnDepth,
  });
  const childTaskMessage = [
    `[Subagent Context] You are running as a subagent (depth ${childDepth}/${maxSpawnDepth}). Results auto-announce to your requester; do not busy-poll for status.`,
    `[Subagent Task]: ${resolvedTask}`,
  ].join("\n\n");

  const childIdem = crypto.randomUUID();
  let childRunId: string = childIdem;
  try {
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
        spawnedBy: spawnedByKey,
        groupId: ctx.agentGroupId ?? undefined,
        groupChannel: ctx.agentGroupChannel ?? undefined,
        groupSpace: ctx.agentGroupSpace ?? undefined,
      },
      timeoutMs: 10_000,
    });
    if (typeof response?.runId === "string" && response.runId) {
      childRunId = response.runId;
    }
  } catch (err) {
    const messageText =
      err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    return {
      status: "error",
      error: messageText,
      childSessionKey,
      runId: childRunId,
    };
  }

  registerSubagentRun({
    runId: childRunId,
    childSessionKey,
    requesterSessionKey: requesterInternalKey,
    requesterOrigin,
    requesterDisplayKey,
    task,
    cleanup,
    label: label || undefined,
    model: resolvedModel,
    runTimeoutSeconds,
    expectsCompletionMessage: params.expectsCompletionMessage === true,
  });

  return {
    status: "accepted",
    childSessionKey,
    runId: childRunId,
    note: SUBAGENT_SPAWN_ACCEPTED_NOTE,
    modelApplied: resolvedModel ? modelApplied : undefined,
  };
}
