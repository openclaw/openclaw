import type { OpenClawConfig } from "../../config/config.js";
export type OutboundIdentity = {
    name?: string;
    avatarUrl?: string;
    emoji?: string;
};
export declare function normalizeOutboundIdentity(identity?: OutboundIdentity | null): OutboundIdentity | undefined;
export declare function resolveAgentOutboundIdentity(cfg: OpenClawConfig, agentId: string): OutboundIdentity | undefined;
