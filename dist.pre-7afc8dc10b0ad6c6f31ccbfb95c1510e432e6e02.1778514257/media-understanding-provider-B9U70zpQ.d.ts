import { f as MediaUnderstandingProvider, m as VideoDescriptionResult, p as VideoDescriptionRequest } from "./types-Bww3J3ev.js";
//#region extensions/moonshot/media-understanding-provider.d.ts
declare function describeMoonshotVideo(params: VideoDescriptionRequest): Promise<VideoDescriptionResult>;
declare const moonshotMediaUnderstandingProvider: MediaUnderstandingProvider;
//#endregion
export { moonshotMediaUnderstandingProvider as n, describeMoonshotVideo as t };