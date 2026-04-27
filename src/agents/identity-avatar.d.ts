import type { OpenClawConfig } from "../config/types.openclaw.js";
export type AgentAvatarResolution = {
    kind: "none";
    reason: string;
    source?: string;
} | {
    kind: "local";
    filePath: string;
    source: string;
} | {
    kind: "remote";
    url: string;
    source: string;
} | {
    kind: "data";
    url: string;
    source: string;
};
type AgentAvatarPublicSourceInput = {
    kind: AgentAvatarResolution["kind"];
    source?: string | null;
};
export declare function resolvePublicAgentAvatarSource(resolved: AgentAvatarPublicSourceInput): string | undefined;
export declare function resolveAgentAvatar(cfg: OpenClawConfig, agentId: string, opts?: {
    includeUiOverride?: boolean;
}): AgentAvatarResolution;
export {};
