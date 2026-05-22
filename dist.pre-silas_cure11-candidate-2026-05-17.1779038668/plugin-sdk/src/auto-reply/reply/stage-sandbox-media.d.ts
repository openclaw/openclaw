import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MsgContext, TemplateContext } from "../templating.js";
export type StageSandboxMediaResult = {
    staged: ReadonlyMap<string, string>;
};
export declare function stageSandboxMedia(params: {
    ctx: MsgContext;
    sessionCtx: TemplateContext;
    cfg: OpenClawConfig;
    sessionKey?: string;
    workspaceDir: string;
}): Promise<StageSandboxMediaResult>;
