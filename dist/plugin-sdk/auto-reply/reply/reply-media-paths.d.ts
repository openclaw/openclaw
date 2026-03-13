import type { OpenClawConfig } from "../../config/config.js";
import type { ReplyPayload } from "../types.js";
export declare function createReplyMediaPathNormalizer(params: {
    cfg: OpenClawConfig;
    sessionKey?: string;
    workspaceDir: string;
}): (payload: ReplyPayload) => Promise<ReplyPayload>;
