import type { GeneratedMusicAsset } from "./types.js";
export type GeneratedMusicFileCandidate = {
    url: string;
    mimeType?: string;
    fileName?: string;
};
export declare function extractGeneratedMusicFileCandidates(payload: unknown, keys?: readonly string[]): GeneratedMusicFileCandidate[];
export declare function generatedMusicAssetFromBase64(params: {
    base64: string;
    mimeType: string;
    index?: number;
    fileName?: string;
}): GeneratedMusicAsset;
export declare function downloadGeneratedMusicAsset(params: {
    candidate: GeneratedMusicFileCandidate;
    timeoutMs: number;
    fetchFn: typeof fetch;
    provider: string;
    requestFailedMessage: string;
    index?: number;
}): Promise<GeneratedMusicAsset>;
