import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { LocalMediaAccessError } from "../../media/local-media-access.js";
type WebchatAudioEmbeddingOptions = {
    localRoots?: readonly string[];
    onLocalAudioAccessDenied?: (err: LocalMediaAccessError) => void;
};
type WebchatAssistantMediaOptions = WebchatAudioEmbeddingOptions;
/**
 * Build Control UI / transcript `content` blocks for local TTS (or other) audio files
 * referenced by slash-command / agent replies when the webchat path only had text aggregation.
 */
export declare function buildWebchatAudioContentBlocksFromReplyPayloads(payloads: ReplyPayload[], options?: WebchatAudioEmbeddingOptions): Promise<Array<Record<string, unknown>>>;
export declare function buildWebchatAssistantMessageFromReplyPayloads(payloads: ReplyPayload[], options?: WebchatAssistantMediaOptions): Promise<{
    content: Array<Record<string, unknown>>;
    transcriptText: string;
} | null>;
export {};
