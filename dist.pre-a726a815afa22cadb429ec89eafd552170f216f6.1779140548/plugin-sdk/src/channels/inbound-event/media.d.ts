import type { HistoryMediaEntry } from "../../auto-reply/reply/history.types.js";
import type { InboundMediaFacts } from "../turn/types.js";
export type ChannelInboundMediaInput = {
    path?: string | null;
    url?: string | null;
    contentType?: string | null;
    kind?: InboundMediaFacts["kind"] | null;
    transcribed?: boolean | null;
    messageId?: string | null;
};
export type ChannelInboundMediaPayload = {
    MediaPath?: string;
    MediaUrl?: string;
    MediaType?: string;
    MediaPaths?: string[];
    MediaUrls?: string[];
    MediaTypes?: string[];
    MediaTranscribedIndexes?: number[];
};
export declare function toInboundMediaFacts(media: readonly ChannelInboundMediaInput[] | null | undefined, defaults?: {
    kind?: InboundMediaFacts["kind"];
    messageId?: string;
    transcribed?: (media: ChannelInboundMediaInput, index: number) => boolean;
}): InboundMediaFacts[];
export declare function toHistoryMediaEntries(media: readonly ChannelInboundMediaInput[] | null | undefined, defaults?: {
    kind?: InboundMediaFacts["kind"];
    messageId?: string;
}): HistoryMediaEntry[];
export declare function buildChannelInboundMediaPayload(media: readonly InboundMediaFacts[] | null | undefined): ChannelInboundMediaPayload;
