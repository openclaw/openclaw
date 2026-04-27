import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveAgentWorkspaceDir } from "./agent-scope.js";
export function normalizeSpawnedRunMetadata(value) {
    return {
        spawnedBy: normalizeOptionalString(value?.spawnedBy),
        groupId: normalizeOptionalString(value?.groupId),
        groupChannel: normalizeOptionalString(value?.groupChannel),
        groupSpace: normalizeOptionalString(value?.groupSpace),
        workspaceDir: normalizeOptionalString(value?.workspaceDir),
    };
}
export function mapToolContextToSpawnedRunMetadata(value) {
    return {
        groupId: normalizeOptionalString(value?.agentGroupId),
        groupChannel: normalizeOptionalString(value?.agentGroupChannel),
        groupSpace: normalizeOptionalString(value?.agentGroupSpace),
        workspaceDir: normalizeOptionalString(value?.workspaceDir),
    };
}
export function resolveSpawnedWorkspaceInheritance(params) {
    const explicit = normalizeOptionalString(params.explicitWorkspaceDir);
    if (explicit) {
        return explicit;
    }
    // For cross-agent spawns, use the target agent's workspace instead of the requester's.
    const agentId = params.targetAgentId ??
        (params.requesterSessionKey
            ? parseAgentSessionKey(params.requesterSessionKey)?.agentId
            : undefined);
    return agentId ? resolveAgentWorkspaceDir(params.config, normalizeAgentId(agentId)) : undefined;
}
export function resolveIngressWorkspaceOverrideForSpawnedRun(metadata) {
    const normalized = normalizeSpawnedRunMetadata(metadata);
    return normalized.spawnedBy ? normalized.workspaceDir : undefined;
}
