import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare const DEFAULT_ASSISTANT_IDENTITY: AssistantIdentity;
type AssistantIdentity = {
    agentId: string;
    name: string;
    avatar: string;
    emoji?: string;
};
export declare function resolveAssistantIdentity(params: {
    cfg: OpenClawConfig;
    agentId?: string | null;
    workspaceDir?: string | null;
}): AssistantIdentity;
export {};
