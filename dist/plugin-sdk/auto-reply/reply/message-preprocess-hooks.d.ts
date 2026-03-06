import type { OpenClawConfig } from "../../config/config.js";
import type { FinalizedMsgContext } from "../templating.js";
export declare function emitPreAgentMessageHooks(params: {
    ctx: FinalizedMsgContext;
    cfg: OpenClawConfig;
    isFastTestEnv: boolean;
}): void;
