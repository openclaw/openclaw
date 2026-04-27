import type { OpenClawConfig } from "../config/types.openclaw.js";
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
    agentMemberRoleIds?: string[];
    workspaceDir?: string;
};
export type NormalizedSpawnedRunMetadata = {
    spawnedBy?: string;
    groupId?: string;
    groupChannel?: string;
    groupSpace?: string;
    workspaceDir?: string;
};
export declare function normalizeSpawnedRunMetadata(value?: SpawnedRunMetadata | null): NormalizedSpawnedRunMetadata;
export declare function mapToolContextToSpawnedRunMetadata(value?: SpawnedToolContext | null): Pick<NormalizedSpawnedRunMetadata, "groupId" | "groupChannel" | "groupSpace" | "workspaceDir">;
export declare function resolveSpawnedWorkspaceInheritance(params: {
    config: OpenClawConfig;
    targetAgentId?: string;
    requesterSessionKey?: string;
    explicitWorkspaceDir?: string | null;
}): string | undefined;
export declare function resolveIngressWorkspaceOverrideForSpawnedRun(metadata?: Pick<SpawnedRunMetadata, "spawnedBy" | "workspaceDir"> | null): string | undefined;
