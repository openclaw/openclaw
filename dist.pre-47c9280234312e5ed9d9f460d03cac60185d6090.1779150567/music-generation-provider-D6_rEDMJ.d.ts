import { c as MusicGenerationProvider } from "./types-D2WBsO9D.js";
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