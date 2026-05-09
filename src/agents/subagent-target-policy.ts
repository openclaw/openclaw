import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";

type SubagentTargetPolicyResult = { ok: true } | { ok: false; allowedText: string; error: string };

type SubagentAllowlistEnv = {
  OPENCLAW_SPAWN_ALLOWLIST?: string;
  SPAWN_ALLOWLIST?: string;
};

export function parseSubagentAllowlistEnv(raw: string | undefined): string[] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const normalized = normalizeStringEntries(parsed);
        return normalized.length > 0 ? normalized : undefined;
      }
    } catch {
      return undefined;
    }
  }
  const normalized = normalizeStringEntries(trimmed.split(","));
  return normalized.length > 0 ? normalized : undefined;
}

export function resolveConfiguredSubagentAllowAgents(params: {
  agentAllowAgents?: readonly string[];
  defaultAllowAgents?: readonly string[];
  env?: SubagentAllowlistEnv;
}): readonly string[] | undefined {
  if (params.agentAllowAgents !== undefined) {
    return params.agentAllowAgents;
  }
  if (params.defaultAllowAgents !== undefined) {
    return params.defaultAllowAgents;
  }
  return (
    parseSubagentAllowlistEnv(params.env?.OPENCLAW_SPAWN_ALLOWLIST) ??
    parseSubagentAllowlistEnv(params.env?.SPAWN_ALLOWLIST)
  );
}

function normalizeAllowAgents(allowAgents: readonly string[] | undefined): {
  configured: boolean;
  allowAny: boolean;
  allowedIds: string[];
} {
  if (!Array.isArray(allowAgents)) {
    return {
      configured: false,
      allowAny: false,
      allowedIds: [],
    };
  }
  const allowedIds = allowAgents
    .map((value) => value.trim())
    .filter((value) => value && value !== "*")
    .map((value) => normalizeAgentId(value))
    .filter(Boolean);
  return {
    configured: true,
    allowAny: allowAgents.some((value) => value.trim() === "*"),
    allowedIds: Array.from(new Set(allowedIds)).toSorted((a, b) => a.localeCompare(b)),
  };
}

export function resolveSubagentAllowedTargetIds(params: {
  requesterAgentId: string;
  allowAgents?: readonly string[];
  configuredAgentIds?: readonly string[];
}): { allowAny: boolean; allowedIds: string[] } {
  const requesterAgentId = normalizeAgentId(params.requesterAgentId);
  const policy = normalizeAllowAgents(params.allowAgents);
  if (!policy.configured) {
    return {
      allowAny: false,
      allowedIds: requesterAgentId ? [requesterAgentId] : [],
    };
  }
  if (policy.allowAny) {
    const configuredIds = (params.configuredAgentIds ?? [])
      .map((id) => normalizeAgentId(id))
      .filter(Boolean);
    return {
      allowAny: true,
      allowedIds: Array.from(new Set(configuredIds)).toSorted((a, b) => a.localeCompare(b)),
    };
  }
  return {
    allowAny: false,
    allowedIds: policy.allowedIds,
  };
}

export function resolveSubagentTargetPolicy(params: {
  requesterAgentId: string;
  targetAgentId: string;
  requestedAgentId?: string;
  allowAgents?: readonly string[];
}): SubagentTargetPolicyResult {
  const requesterAgentId = normalizeAgentId(params.requesterAgentId);
  const targetAgentId = normalizeAgentId(params.targetAgentId);
  if (!params.requestedAgentId?.trim() && targetAgentId === requesterAgentId) {
    return { ok: true };
  }

  const allowed = resolveSubagentAllowedTargetIds({
    requesterAgentId,
    allowAgents: params.allowAgents,
  });
  if (allowed.allowAny || allowed.allowedIds.includes(targetAgentId)) {
    return { ok: true };
  }
  const allowedText = allowed.allowedIds.length > 0 ? allowed.allowedIds.join(", ") : "none";
  return {
    ok: false,
    allowedText,
    error: `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`,
  };
}
