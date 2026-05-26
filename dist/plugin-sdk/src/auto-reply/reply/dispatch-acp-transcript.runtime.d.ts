import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function persistAcpDispatchTranscript(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    promptText: string;
    finalText: string;
    meta?: SessionAcpMeta;
    threadId?: string | number;
}): Promise<void>;
