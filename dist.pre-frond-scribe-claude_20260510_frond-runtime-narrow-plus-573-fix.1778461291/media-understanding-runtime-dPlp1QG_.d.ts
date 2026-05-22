import { i as ImageDescriptionResult } from "./types-BhKoQMlH.js";
import { a as RunMediaUnderstandingFileParams, n as DescribeImageFileWithModelParams, o as RunMediaUnderstandingFileResult, r as DescribeVideoFileParams, s as TranscribeAudioFileParams, t as DescribeImageFileParams } from "./runtime-types-BInap2_s.js";

//#region src/media-understanding/runtime.d.ts
declare function runMediaUnderstandingFile(params: RunMediaUnderstandingFileParams): Promise<RunMediaUnderstandingFileResult>;
declare function describeImageFile(params: DescribeImageFileParams): Promise<RunMediaUnderstandingFileResult>;
declare function describeImageFileWithModel(params: DescribeImageFileWithModelParams): Promise<ImageDescriptionResult>;
declare function describeVideoFile(params: DescribeVideoFileParams): Promise<RunMediaUnderstandingFileResult>;
declare function transcribeAudioFile(params: TranscribeAudioFileParams): Promise<RunMediaUnderstandingFileResult>;
//#endregion
export { transcribeAudioFile as a, runMediaUnderstandingFile as i, describeImageFileWithModel as n, describeVideoFile as r, describeImageFile as t };