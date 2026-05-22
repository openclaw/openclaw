import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function shouldSuppressLocalExecApprovalPrompt(params: {
    channel?: string | null;
    cfg: OpenClawConfig;
    accountId?: string | null;
    payload: ReplyPayload;
}): boolean;
