import type { ChannelThreadingToolContext } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
type SourceReplyTranscriptMirrorParams = {
    action: string;
    channel: string;
    actionParams: Record<string, unknown>;
    cfg: OpenClawConfig;
    sessionKey?: string;
    agentId?: string;
    toolContext?: ChannelThreadingToolContext;
    idempotencyKey?: string;
    deliveredPayload?: unknown;
};
export declare function mirrorDeliveredSourceReplyToTranscript(params: SourceReplyTranscriptMirrorParams): Promise<boolean>;
export {};
