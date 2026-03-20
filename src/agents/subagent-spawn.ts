import crypto from "node:crypto";
import { formatThinkingLevels, normalizeThinkLevel } from "../auto-reply/thinking.js";
import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import { buildSubagentSystemPrompt } from "./subagent-announce.js";
import { registerSubagentRun } from "./subagent-registry.js";
import {
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./tools/sessions-helpers.js";

export type SpawnSubagentRunParams = {
  task: string;
  label?: string;
  requestedAgentId?: string;
  modelOverride?: string;
  thinkingOverrideRaw?: string;
  runTimeoutSeconds?: number;
  cleanup?: "delete" | "keep";
  requesterSessionKey?: string;
  requesterAgentIdOverride?: string;
  requesterOrigin?: DeliveryContext;
  requesterGroupId?: string | null;
  requesterGroupChannel?: string | null;
  requesterGroupSpace?: string | null;
};

export type SpawnSubagentRunResult =
  | {
      status: "accepted";
      childSessionKey: string;
      runId: string;
      modelApplied?: boolean;
      warning?: string;
    }
  | {
      status: "error" | "forbidden";
      error: string;
      childSessionKey?: string;
      runId?: string;
    };

function splitModelRef(ref?: string) {
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

function normalizeModelSelection(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const primary = (value as { primary?: unknown }).primary;
  if (typeof primary === "string" && primary.trim()) {
    return primary.trim();
  }
  return undefined;
}

export async function spawnSubagentRun(
  params: SpawnSubagentRunParams,
): Promise<SpawnSubagentRunResult> {
  const cfg = loadConfig();
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const requesterSessionKey = params.requesterSessionKey;
  if (typeof requesterSessionKey === "string" && isSubagentSessionKey(requesterSessionKey)) {
    return {
      status: "forbidden",
      error: "sessions_spawn is not allowed from sub-agent sessions",
    };
  }

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
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const requesterAgentId = normalizeAgentId(
    params.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
  );
  const targetAgentId = params.requestedAgentId
    ? normalizeAgentId(params.requestedAgentId)
    : requesterAgentId;

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
      const allowedText =
        allowSet.size > 0 ? Array.from(allowSet).join(", ") : allowAny ? "*" : "none";
      return {
        status: "forbidden",
        error: `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`,
      };
    }
  }

  const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
  const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
  const resolvedModel =
    normalizeModelSelection(params.modelOverride) ??
    normalizeModelSelection(targetAgentConfig?.subagents?.model) ??
    normalizeModelSelection(cfg.agents?.defaults?.subagents?.model);

  const resolvedThinkingDefaultRaw =
    typeof targetAgentConfig?.subagents?.thinking === "string"
      ? targetAgentConfig.subagents.thinking
      : typeof cfg.agents?.defaults?.subagents?.thinking === "string"
        ? cfg.agents.defaults.subagents.thinking
        : undefined;

  let modelWarning: string | undefined;
  let modelApplied = false;
  let thinkingOverride: string | undefined;
  const thinkingCandidateRaw = params.thinkingOverrideRaw || resolvedThinkingDefaultRaw;
  if (thinkingCandidateRaw) {
    const normalized = normalizeThinkLevel(thinkingCandidateRaw);
    if (!normalized) {
      const { provider, model } = splitModelRef(resolvedModel);
      return {
        status: "error",
        error: `Invalid thinking level "${thinkingCandidateRaw}". Use one of: ${formatThinkingLevels(provider, model)}.`,
      };
    }
    thinkingOverride = normalized;
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
      const recoverable =
        messageText.includes("invalid model") || messageText.includes("model not allowed");
      if (!recoverable) {
        return {
          status: "error",
          error: messageText,
          childSessionKey,
        };
      }
      modelWarning = messageText;
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
    label: params.label,
    task: params.task,
  });

  const childIdem = crypto.randomUUID();
  let childRunId: string = childIdem;
  try {
    const response = await callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: params.task,
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
        timeout:
          params.runTimeoutSeconds && params.runTimeoutSeconds > 0
            ? params.runTimeoutSeconds
            : undefined,
        label: params.label,
        spawnedBy: requesterInternalKey,
        groupId: params.requesterGroupId ?? undefined,
        groupChannel: params.requesterGroupChannel ?? undefined,
        groupSpace: params.requesterGroupSpace ?? undefined,
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
    task: params.task,
    cleanup: params.cleanup ?? "keep",
    label: params.label,
    runTimeoutSeconds: params.runTimeoutSeconds,
  });

  return {
    status: "accepted",
    childSessionKey,
    runId: childRunId,
    modelApplied: resolvedModel ? modelApplied : undefined,
    warning: modelWarning,
  };
}
