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
  targetAgentId?: string;
  explicitWorkspaceDir?: string | null;
}): string | undefined {
  const requesterAgentId = params.requesterSessionKey
    ? parseAgentSessionKey(params.requesterSessionKey)?.agentId
    : undefined;
  const targetId = params.targetAgentId ? normalizeAgentId(params.targetAgentId) : undefined;
  const explicit = normalizeOptionalText(params.explicitWorkspaceDir);
  const requesterWorkspace = requesterAgentId
    ? resolveAgentWorkspaceDir(params.config, normalizeAgentId(requesterAgentId))
    : undefined;

  // Cross-agent spawn: target differs from requester → use target's workspace only
  // when target has explicit workspace in agents.list; otherwise inherit.
  if (targetId && requesterAgentId && targetId !== normalizeAgentId(requesterAgentId)) {
    const targetWorkspace = resolveAgentConfig(params.config, targetId)?.workspace;
    const targetHasExplicitWorkspace =
      typeof targetWorkspace === "string" && targetWorkspace.trim().length > 0;
    if (targetHasExplicitWorkspace) {
      return undefined;
    }
  }

  if (explicit) {
    return explicit;
  }
  return requesterWorkspace;
}

export function resolveIngressWorkspaceOverrideForSpawnedRun(
  metadata?: Pick<SpawnedRunMetadata, "spawnedBy" | "workspaceDir"> | null,
): string | undefined {
  const normalized = normalizeSpawnedRunMetadata(metadata);
  return normalized.spawnedBy ? normalized.workspaceDir : undefined;
}
