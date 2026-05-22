import type { HistoryMediaEntry } from "../../auto-reply/reply/history.types.js";
import type { InboundMediaFacts } from "./types.js";
export type ChannelTurnMediaInput = {
    path?: string | null;
    url?: string | null;
    contentType?: string | null;
    kind?: InboundMediaFacts["kind"] | null;
    transcribed?: boolean | null;
    messageId?: string | null;
};
export type ChannelTurnMediaPayload = {
    MediaPath?: string;
    MediaUrl?: string;
    MediaType?: string;
    MediaPaths?: string[];
    MediaUrls?: string[];
    MediaTypes?: string[];
    MediaTranscribedIndexes?: number[];
};
export declare function toInboundMediaFacts(media: readonly ChannelTurnMediaInput[] | null | undefined, defaults?: {
    kind?: InboundMediaFacts["kind"];
    messageId?: string;
    transcribed?: (media: ChannelTurnMediaInput, index: number) => boolean;
}): InboundMediaFacts[];
export declare function toHistoryMediaEntries(media: readonly ChannelTurnMediaInput[] | null | undefined, defaults?: {
    kind?: InboundMediaFacts["kind"];
    messageId?: string;
}): HistoryMediaEntry[];
export declare function buildChannelTurnMediaPayload(media: readonly InboundMediaFacts[] | null | undefined): ChannelTurnMediaPayload;
