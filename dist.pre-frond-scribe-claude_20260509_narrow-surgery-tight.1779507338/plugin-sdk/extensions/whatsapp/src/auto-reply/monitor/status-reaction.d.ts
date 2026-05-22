import { type StatusReactionController } from "openclaw/plugin-sdk/channel-feedback";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { WebInboundMsg } from "../types.js";
export type { StatusReactionController };
export type WhatsAppStatusReactionParams = {
    cfg: OpenClawConfig;
    msg: WebInboundMsg;
    agentId: string;
    sessionKey: string;
    conversationId: string;
    verbose: boolean;
    accountId?: string;
};
export declare function createWhatsAppStatusReactionController(params: WhatsAppStatusReactionParams): Promise<StatusReactionController | null>;
