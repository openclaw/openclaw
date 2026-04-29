import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

type RecordLike = Record<string, unknown>;

export type MemorySearchScope = {
  requesterAgentId: string;
  allowedAgentIds: string[];
  crossAgent: boolean;
};

function asRecord(value: unknown): RecordLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : undefined;
}

function normalizeAgentId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed || undefined;
}

function normalizeAgentIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids = value.map(normalizeAgentId).filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

function listConfiguredAgentIds(cfg: OpenClawConfig): string[] {
  const ids = normalizeAgentIdList(cfg.agents?.list?.map((entry) => entry?.id));
  return ids;
}

function resolveMemoryCoreSearchScopeConfig(cfg: OpenClawConfig): RecordLike {
  const entry = asRecord(cfg.plugins?.entries?.["memory-core"]);
  const pluginConfig = asRecord(entry?.config);
  return asRecord(pluginConfig?.searchScope) ?? {};
}

/**
 * Resolve the tool-layer memory_search scope from trusted runtime identity only.
 *
 * Deliberately does not read tool parameters: frontend/model supplied params must not be able to
 * broaden the effective agent scope. Future target-agent filters should only narrow this result.
 */
export function resolveMemorySearchScope(params: {
  cfg: OpenClawConfig;
  requesterAgentId: string;
}): MemorySearchScope {
  const requesterAgentId = normalizeAgentId(params.requesterAgentId) ?? params.requesterAgentId;
  const scopeConfig = resolveMemoryCoreSearchScopeConfig(params.cfg);
  const chiefAgentIds = normalizeAgentIdList(scopeConfig.chiefAgentIds);
  const effectiveChiefAgentIds = chiefAgentIds.length > 0 ? chiefAgentIds : ["chief"];
  const isChief = effectiveChiefAgentIds.includes(requesterAgentId);
  if (!isChief || scopeConfig.chiefCrossAgent === false) {
    return {
      requesterAgentId,
      allowedAgentIds: [requesterAgentId],
      crossAgent: false,
    };
  }

  const configuredAllowedAgentIds = normalizeAgentIdList(scopeConfig.allowedAgentIds);
  const configuredAgentIds = listConfiguredAgentIds(params.cfg);
  const allowedAgentIds =
    configuredAllowedAgentIds.length > 0
      ? configuredAllowedAgentIds.filter((agentId) =>
          configuredAgentIds.length > 0 ? configuredAgentIds.includes(agentId) : true,
        )
      : configuredAgentIds;
  const effectiveAllowedAgentIds =
    allowedAgentIds.length > 0 ? allowedAgentIds : [requesterAgentId];

  return {
    requesterAgentId,
    allowedAgentIds: effectiveAllowedAgentIds,
    crossAgent: effectiveAllowedAgentIds.some((agentId) => agentId !== requesterAgentId),
  };
}
