import type { loadConfig } from "../../../config/config.js";
export declare function resolveGroupPolicyFor(cfg: ReturnType<typeof loadConfig>, conversationId: string): import("../../../config/group-policy.js").ChannelGroupPolicy;
export declare function resolveGroupRequireMentionFor(cfg: ReturnType<typeof loadConfig>, conversationId: string): boolean;
export declare function resolveGroupActivationFor(params: {
    cfg: ReturnType<typeof loadConfig>;
    agentId: string;
    sessionKey: string;
    conversationId: string;
}): import("../../../auto-reply/group-activation.js").GroupActivationMode;
