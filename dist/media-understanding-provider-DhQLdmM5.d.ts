import { f as MediaUnderstandingProvider, v as VideoDescriptionRequest, y as VideoDescriptionResult } from "./types-ByzWuf9L.js";
//#region extensions/qwen/media-understanding-provider.d.ts
declare function describeQwenVideo(params: VideoDescriptionRequest): Promise<VideoDescriptionResult>;
declare function buildQwenMediaUnderstandingProvider(): MediaUnderstandingProvider;
//#endregion
export { describeQwenVideo as n, buildQwenMediaUnderstandingProvider as t };