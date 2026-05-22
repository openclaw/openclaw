import { f as MediaUnderstandingProvider, m as VideoDescriptionResult, p as VideoDescriptionRequest } from "./types-BhKoQMlH.js";
//#region extensions/moonshot/media-understanding-provider.d.ts
declare function describeMoonshotVideo(params: VideoDescriptionRequest): Promise<VideoDescriptionResult>;
declare const moonshotMediaUnderstandingProvider: MediaUnderstandingProvider;
//#endregion
export { moonshotMediaUnderstandingProvider as n, describeMoonshotVideo as t };