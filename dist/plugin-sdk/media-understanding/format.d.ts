import type { MediaUnderstandingOutput } from "./types.js";
export declare function extractMediaUserText(body?: string): string | undefined;
export declare function formatMediaUnderstandingBody(params: {
    body?: string;
    outputs: MediaUnderstandingOutput[];
}): string;
export declare function formatAudioTranscripts(outputs: MediaUnderstandingOutput[]): string;
