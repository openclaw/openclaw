import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function recordInboundSessionMetaSafe(params: {
    cfg: OpenClawConfig;
    agentId: string;
    sessionKey: string;
    ctx: MsgContext;
    onError?: (error: unknown) => void;
}): Promise<void>;
