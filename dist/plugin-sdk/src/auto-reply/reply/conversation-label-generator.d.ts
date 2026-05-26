import type { OpenClawConfig } from "../../config/types.openclaw.js";
export type ConversationLabelParams = {
    userMessage: string;
    prompt: string;
    cfg: OpenClawConfig;
    agentId?: string;
    agentDir?: string;
    maxLength?: number;
};
export declare function generateConversationLabel(params: ConversationLabelParams): Promise<string | null>;
