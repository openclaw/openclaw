import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionsPatchParams } from "./protocol/index.js";
export declare function triggerSessionPatchHook(params: {
    cfg: OpenClawConfig;
    sessionEntry: SessionEntry;
    sessionKey: string;
    patch: SessionsPatchParams;
}): void;
