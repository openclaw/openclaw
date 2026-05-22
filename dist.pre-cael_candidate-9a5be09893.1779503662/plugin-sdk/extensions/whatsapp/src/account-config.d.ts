import { type OpenClawConfig } from "openclaw/plugin-sdk/account-core";
import type { WhatsAppAccountConfig } from "./account-types.js";
export declare function resolveMergedWhatsAppAccountConfig(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): WhatsAppAccountConfig & {
    accountId: string;
};
