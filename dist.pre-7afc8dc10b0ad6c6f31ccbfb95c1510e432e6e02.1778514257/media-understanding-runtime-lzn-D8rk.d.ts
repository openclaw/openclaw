import { i as ImageDescriptionResult } from "./types-Bww3J3ev.js";
import { a as RunMediaUnderstandingFileParams, n as DescribeImageFileWithModelParams, o as RunMediaUnderstandingFileResult, r as DescribeVideoFileParams, s as TranscribeAudioFileParams, t as DescribeImageFileParams } from "./runtime-types-D77ipqXj.js";

//#region src/media-understanding/runtime.d.ts
declare function runMediaUnderstandingFile(params: RunMediaUnderstandingFileParams): Promise<RunMediaUnderstandingFileResult>;
declare function describeImageFile(params: DescribeImageFileParams): Promise<RunMediaUnderstandingFileResult>;
declare function describeImageFileWithModel(params: DescribeImageFileWithModelParams): Promise<ImageDescriptionResult>;
declare function describeVideoFile(params: DescribeVideoFileParams): Promise<RunMediaUnderstandingFileResult>;
declare function transcribeAudioFile(params: TranscribeAudioFileParams): Promise<RunMediaUnderstandingFileResult>;
//#endregion
export { transcribeAudioFile as a, runMediaUnderstandingFile as i, describeImageFileWithModel as n, describeVideoFile as r, describeImageFile as t };