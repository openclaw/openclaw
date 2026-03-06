import type { SkillEligibilityContext } from "../agents/skills.js";
import type { OpenClawConfig } from "../config/config.js";
import type { NodeRegistry } from "../gateway/node-registry.js";
export declare function setSkillsRemoteRegistry(registry: NodeRegistry | null): void;
export declare function primeRemoteSkillsCache(): Promise<void>;
export declare function recordRemoteNodeInfo(node: {
    nodeId: string;
    displayName?: string;
    platform?: string;
    deviceFamily?: string;
    commands?: string[];
    remoteIp?: string;
}): void;
export declare function recordRemoteNodeBins(nodeId: string, bins: string[]): void;
export declare function removeRemoteNodeInfo(nodeId: string): void;
export declare function refreshRemoteNodeBins(params: {
    nodeId: string;
    platform?: string;
    deviceFamily?: string;
    commands?: string[];
    cfg: OpenClawConfig;
    timeoutMs?: number;
}): Promise<void>;
export declare function getRemoteSkillEligibility(): SkillEligibilityContext["remote"] | undefined;
export declare function refreshRemoteBinsForConnectedNodes(cfg: OpenClawConfig): Promise<void>;
