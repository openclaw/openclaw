import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
type ApplyLinkUnderstandingResult = {
    outputs: string[];
    urls: string[];
};
export declare function applyLinkUnderstanding(params: {
    ctx: MsgContext;
    cfg: OpenClawConfig;
}): Promise<ApplyLinkUnderstandingResult>;
export {};
