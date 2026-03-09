import type { OpenClawConfig } from "../config/config.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveAgentConfig, resolveAgentWorkspaceDir } from "./agent-scope.js";

export type SpawnedRunMetadata = {
  spawnedBy?: string | null;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  workspaceDir?: string | null;
};

export type SpawnedToolContext = {
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  workspaceDir?: string;
};

export type NormalizedSpawnedRunMetadata = {
  spawnedBy?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  workspaceDir?: string;
};

function normalizeOptionalText(value?: string | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function normalizeSpawnedRunMetadata(
  value?: SpawnedRunMetadata | null,
): NormalizedSpawnedRunMetadata {
  return {
    spawnedBy: normalizeOptionalText(value?.spawnedBy),
    groupId: normalizeOptionalText(value?.groupId),
    groupChannel: normalizeOptionalText(value?.groupChannel),
    groupSpace: normalizeOptionalText(value?.groupSpace),
    workspaceDir: normalizeOptionalText(value?.workspaceDir),
  };
}

export function mapToolContextToSpawnedRunMetadata(
  value?: SpawnedToolContext | null,
): Pick<NormalizedSpawnedRunMetadata, "groupId" | "groupChannel" | "groupSpace" | "workspaceDir"> {
  return {
    groupId: normalizeOptionalText(value?.agentGroupId),
    groupChannel: normalizeOptionalText(value?.agentGroupChannel),
    groupSpace: normalizeOptionalText(value?.agentGroupSpace),
    workspaceDir: normalizeOptionalText(value?.workspaceDir),
  };
}

export function resolveSpawnedWorkspaceInheritance(params: {
  config: OpenClawConfig;
  requesterSessionKey?: string;
  explicitWorkspaceDir?: string | null;
  /** Target agent ID for sessions_spawn(agentId=...). When set, use its configured workspace if available. */
  targetAgentId?: string;
}): string | undefined {
  const explicit = normalizeOptionalText(params.explicitWorkspaceDir);
  if (explicit) {
    return explicit;
  }
  // If spawning to a specific target agent with an explicitly configured workspace, use that.
  // This fixes #40825: sessions_spawn(agentId) should respect agent's configured workspace.
  // Only use the target's workspace if it is explicitly configured; otherwise fall back to parent.
  if (params.targetAgentId) {
    const targetConfig = resolveAgentConfig(params.config, normalizeAgentId(params.targetAgentId));
    if (targetConfig?.workspace) {
      return targetConfig.workspace;
    }
  }
  const requesterAgentId = params.requesterSessionKey
    ? parseAgentSessionKey(params.requesterSessionKey)?.agentId
    : undefined;
  return requesterAgentId
    ? resolveAgentWorkspaceDir(params.config, normalizeAgentId(requesterAgentId))
    : undefined;
}

export function resolveIngressWorkspaceOverrideForSpawnedRun(
  metadata?: Pick<SpawnedRunMetadata, "spawnedBy" | "workspaceDir"> | null,
): string | undefined {
  const normalized = normalizeSpawnedRunMetadata(metadata);
  return normalized.spawnedBy ? normalized.workspaceDir : undefined;
}
