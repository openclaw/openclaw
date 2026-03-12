import type { OpenClawConfig } from "../../config/config.js";
export declare function resolveAuthorizedWhatsAppOutboundTarget(params: {
    cfg: OpenClawConfig;
    chatJid: string;
    accountId?: string;
    actionLabel: string;
}): {
    to: string;
    accountId: string;
};
