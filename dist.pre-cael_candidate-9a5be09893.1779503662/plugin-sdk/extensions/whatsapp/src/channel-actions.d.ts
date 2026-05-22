import { type ChannelMessageActionName, type OpenClawConfig } from "./channel-actions.runtime.js";
export declare function resolveWhatsAppAgentReactionGuidance(params: {
    cfg: OpenClawConfig;
    accountId?: string;
}): "extensive" | "minimal" | undefined;
export declare function describeWhatsAppMessageActions(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): {
    actions: ChannelMessageActionName[];
} | null;
