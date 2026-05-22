import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import type { EmbeddedPiRunResult } from "../types.js";
type EmbeddedRunPayload = NonNullable<EmbeddedPiRunResult["payloads"]>[number];
export declare function mergeAttemptToolMediaPayloads(params: {
    payloads?: EmbeddedRunPayload[];
    toolMediaUrls?: string[];
    toolAudioAsVoice?: boolean;
    toolTrustedLocalMedia?: boolean;
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
}): EmbeddedRunPayload[] | undefined;
export {};
