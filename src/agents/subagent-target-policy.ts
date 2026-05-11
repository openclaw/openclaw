import { normalizeAgentId } from "../routing/session-key.js";

const SPAWN_ALLOWLIST_ENV_VAR = "SPAWN_ALLOWLIST";

type SubagentTargetPolicyResult = { ok: true } | { ok: false; allowedText: string; error: string };

/**
 * Read the `SPAWN_ALLOWLIST` environment variable as a fallback subagent
 * allowlist when neither the per-agent `subagents.allowAgents` nor the
 * `agents.defaults.subagents.allowAgents` config keys are set. This lets
 * Docker / Kubernetes / Coolify deployments that ship `AGENTS=[...]` purely
 * through env vars also configure the spawn allowlist without having to
 * mount or write a config file. Comma-separated; `*` is preserved verbatim
 * so it flows through `normalizeAllowAgents`'s "allow any" branch.
 *
 * Returns `undefined` when the env var is unset or empty so callers can
 * keep using the standard nullish-coalescing chain
 * (`config-per-agent ?? config-default ?? env`).
 *
 * Refs #79490.
 */
export function resolveSpawnAllowlistFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  const raw = env[SPAWN_ALLOWLIST_ENV_VAR];
  if (typeof raw !== "string") {
    return undefined;
  }
  const parts = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
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
