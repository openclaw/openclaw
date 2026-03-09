import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { listAgentEntries, resolveAgentConfig } from "./agent-scope.js";

export type AllowedSubagentTarget = {
  id: string;
  name?: string;
  configured: boolean;
};

export type ResolvedSubagentAllowlist = {
  requester: string;
  allowAny: boolean;
  crossAgentIds: string[];
  agents: AllowedSubagentTarget[];
};

export function resolveAllowedSubagentTargets(params: {
  cfg: OpenClawConfig;
  requesterAgentId?: string | null;
}): ResolvedSubagentAllowlist {
  const requesterAgentId = normalizeAgentId(params.requesterAgentId ?? DEFAULT_AGENT_ID);
  const allowAgents =
    resolveAgentConfig(params.cfg, requesterAgentId)?.subagents?.allowAgents ?? [];
  const allowAny = allowAgents.some((value) => value.trim() === "*");
  const crossAgentIds = Array.from(
    new Set(
      allowAgents
        .filter((value) => value.trim() && value.trim() !== "*")
        .map((value) => normalizeAgentId(value)),
    ),
  );

  const configuredIds = new Set<string>();
  const configuredNameMap = new Map<string, string>();
  for (const entry of listAgentEntries(params.cfg)) {
    const id = normalizeAgentId(entry.id);
    configuredIds.add(id);
    const name = entry?.name?.trim() ?? "";
    if (name && !configuredNameMap.has(id)) {
      configuredNameMap.set(id, name);
    }
  }

  const allowed = new Set<string>([requesterAgentId]);
  if (allowAny) {
    for (const id of configuredIds) {
      allowed.add(id);
    }
  } else {
    for (const id of crossAgentIds) {
      allowed.add(id);
    }
  }

  const orderedIds = [
    requesterAgentId,
    ...Array.from(allowed)
      .filter((id) => id !== requesterAgentId)
      .toSorted((a, b) => a.localeCompare(b)),
  ];

  return {
    requester: requesterAgentId,
    allowAny,
    crossAgentIds,
    agents: orderedIds.map((id) => ({
      id,
      name: configuredNameMap.get(id),
      configured: configuredIds.has(id),
    })),
  };
}
