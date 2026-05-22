import { f as MediaUnderstandingProvider, m as VideoDescriptionResult, p as VideoDescriptionRequest } from "./types-BhKoQMlH.js";
//#region extensions/qwen/media-understanding-provider.d.ts
declare function describeQwenVideo(params: VideoDescriptionRequest): Promise<VideoDescriptionResult>;
declare function buildQwenMediaUnderstandingProvider(): MediaUnderstandingProvider;
//#endregion
export { describeQwenVideo as n, buildQwenMediaUnderstandingProvider as t };