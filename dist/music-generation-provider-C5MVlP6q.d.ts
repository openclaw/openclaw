import { c as MusicGenerationProvider } from "./types-M_PrR5fi.js";
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
declare const openRouterMusicTestInternals: {
  readOpenRouterAudioStream: typeof readOpenRouterAudioStream;
};
//#endregion
export { openRouterMusicTestInternals as n, buildOpenRouterMusicGenerationProvider as t };