import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
export declare function isDiscordExecApprovalClientEnabled(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): boolean;
export declare function shouldSuppressLocalDiscordExecApprovalPrompt(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    payload: ReplyPayload;
}): boolean;
