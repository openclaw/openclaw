import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext, TemplateContext } from "../templating.js";
export declare function stageSandboxMedia(params: {
    ctx: MsgContext;
    sessionCtx: TemplateContext;
    cfg: OpenClawConfig;
    sessionKey?: string;
    workspaceDir: string;
}): Promise<void>;
