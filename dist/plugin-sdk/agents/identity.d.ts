import type { OpenClawConfig, HumanDelayConfig, IdentityConfig } from "../config/config.js";
export declare function resolveAgentIdentity(cfg: OpenClawConfig, agentId: string): IdentityConfig | undefined;
export declare function resolveAckReaction(cfg: OpenClawConfig, agentId: string, opts?: {
    channel?: string;
    accountId?: string;
}): string;
export declare function resolveIdentityNamePrefix(cfg: OpenClawConfig, agentId: string): string | undefined;
/** Returns just the identity name (without brackets) for template context. */
export declare function resolveIdentityName(cfg: OpenClawConfig, agentId: string): string | undefined;
export declare function resolveMessagePrefix(cfg: OpenClawConfig, agentId: string, opts?: {
    configured?: string;
    hasAllowFrom?: boolean;
    fallback?: string;
}): string;
export declare function resolveResponsePrefix(cfg: OpenClawConfig, agentId: string, opts?: {
    channel?: string;
    accountId?: string;
}): string | undefined;
export declare function resolveEffectiveMessagesConfig(cfg: OpenClawConfig, agentId: string, opts?: {
    hasAllowFrom?: boolean;
    fallbackMessagePrefix?: string;
    channel?: string;
    accountId?: string;
}): {
    messagePrefix: string;
    responsePrefix?: string;
};
export declare function resolveHumanDelayConfig(cfg: OpenClawConfig, agentId: string): HumanDelayConfig | undefined;
