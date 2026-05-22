import { f as MediaUnderstandingProvider, v as VideoDescriptionRequest, y as VideoDescriptionResult } from "./types-N0vvD1GV.js";
//#region extensions/moonshot/media-understanding-provider.d.ts
declare function describeMoonshotVideo(params: VideoDescriptionRequest): Promise<VideoDescriptionResult>;
declare const moonshotMediaUnderstandingProvider: MediaUnderstandingProvider;
//#endregion
export { moonshotMediaUnderstandingProvider as n, describeMoonshotVideo as t };