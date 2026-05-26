import { t as GeneratedMusicAsset } from "./types-M_PrR5fi.js";

//#region src/music-generation/provider-assets.d.ts
type GeneratedMusicFileCandidate = {
  url: string;
  mimeType?: string;
  fileName?: string;
};
declare function extractGeneratedMusicFileCandidates(payload: unknown, keys?: readonly string[]): GeneratedMusicFileCandidate[];
declare function generatedMusicAssetFromBase64(params: {
  base64: string;
  mimeType: string;
  index?: number;
  fileName?: string;
}): GeneratedMusicAsset;
declare function downloadGeneratedMusicAsset(params: {
  candidate: GeneratedMusicFileCandidate;
  timeoutMs: number;
  fetchFn: typeof fetch;
  provider: string;
  requestFailedMessage: string;
  index?: number;
}): Promise<GeneratedMusicAsset>;
//#endregion
export { generatedMusicAssetFromBase64 as i, downloadGeneratedMusicAsset as n, extractGeneratedMusicFileCandidates as r, GeneratedMusicFileCandidate as t };