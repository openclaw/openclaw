import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export declare function resolveGroupActivationFor(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    agentId: string;
    sessionKey: string;
    conversationId: string;
}): Promise<import("openclaw/plugin-sdk/group-activation").GroupActivationMode>;
