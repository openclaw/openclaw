import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FinalizedMsgContext } from "../templating.js";
export declare function emitPreAgentMessageHooks(params: {
    ctx: FinalizedMsgContext;
    cfg: OpenClawConfig;
    isFastTestEnv: boolean;
}): void;
