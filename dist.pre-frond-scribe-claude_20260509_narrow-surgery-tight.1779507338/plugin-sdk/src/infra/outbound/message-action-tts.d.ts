import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
export declare function resolveMessageActionSessionTtsAuto(params: {
    cfg: OpenClawConfig;
    sessionKey?: string;
    agentId?: string;
}): TtsAutoMode | undefined;
export declare function maybeApplyTtsToMessageActionSendPayload(params: {
    payload: ReplyPayload;
    cfg: OpenClawConfig;
    channel: string;
    accountId?: string | null;
    agentId?: string;
    sessionKey?: string;
    inboundAudio?: boolean;
    dryRun: boolean;
}): Promise<ReplyPayload>;
