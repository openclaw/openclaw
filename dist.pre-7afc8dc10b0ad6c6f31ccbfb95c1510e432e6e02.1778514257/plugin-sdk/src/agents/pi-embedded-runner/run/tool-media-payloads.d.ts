import type { EmbeddedPiRunResult } from "../types.js";
type EmbeddedRunPayload = NonNullable<EmbeddedPiRunResult["payloads"]>[number];
export declare function mergeAttemptToolMediaPayloads(params: {
    payloads?: EmbeddedRunPayload[];
    toolMediaUrls?: string[];
    toolAudioAsVoice?: boolean;
}): EmbeddedRunPayload[] | undefined;
export {};
