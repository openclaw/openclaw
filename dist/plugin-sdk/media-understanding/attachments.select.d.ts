import type { MediaUnderstandingAttachmentsConfig } from "../config/types.tools.js";
import type { MediaAttachment, MediaUnderstandingCapability } from "./types.js";
export declare function selectAttachments(params: {
    capability: MediaUnderstandingCapability;
    attachments: MediaAttachment[];
    policy?: MediaUnderstandingAttachmentsConfig;
}): MediaAttachment[];
