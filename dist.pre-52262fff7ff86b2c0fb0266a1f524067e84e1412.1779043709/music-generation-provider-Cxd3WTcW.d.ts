import { c as MusicGenerationProvider } from "./types-vldPwSpF.js";
//#region extensions/openrouter/music-generation-provider.d.ts
type OpenRouterAudioStreamResult = {
  audioBuffer: Buffer;
  transcript: string;
};
type OpenRouterStreamDeadline = {
  deadlineAtMs: number;
  timeoutMs: number;
};
declare function readOpenRouterAudioStream(response: Response, deadline: OpenRouterStreamDeadline): Promise<OpenRouterAudioStreamResult>;
declare function buildOpenRouterMusicGenerationProvider(): MusicGenerationProvider;
declare const _openRouterMusicTestInternals: {
  readOpenRouterAudioStream: typeof readOpenRouterAudioStream;
};
//#endregion
export { buildOpenRouterMusicGenerationProvider as n, _openRouterMusicTestInternals as t };