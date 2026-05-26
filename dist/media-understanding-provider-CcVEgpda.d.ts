import { f as MediaUnderstandingProvider, v as VideoDescriptionRequest, y as VideoDescriptionResult } from "./types-Dp_Bsq2N.js";
//#region extensions/qwen/media-understanding-provider.d.ts
declare function describeQwenVideo(params: VideoDescriptionRequest): Promise<VideoDescriptionResult>;
declare function buildQwenMediaUnderstandingProvider(): MediaUnderstandingProvider;
//#endregion
export { describeQwenVideo as n, buildQwenMediaUnderstandingProvider as t };