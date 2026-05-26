import { g as StructuredExtractionResult, i as ImageDescriptionResult } from "./types-ByzWuf9L.js";
import { c as TranscribeAudioFileParams, i as ExtractStructuredWithModelParams, n as DescribeImageFileWithModelParams, o as RunMediaUnderstandingFileParams, r as DescribeVideoFileParams, s as RunMediaUnderstandingFileResult, t as DescribeImageFileParams } from "./runtime-types-C5ygRBi_.js";

//#region src/media-understanding/runtime.d.ts
declare function runMediaUnderstandingFile(params: RunMediaUnderstandingFileParams): Promise<RunMediaUnderstandingFileResult>;
declare function describeImageFile(params: DescribeImageFileParams): Promise<RunMediaUnderstandingFileResult>;
declare function describeImageFileWithModel(params: DescribeImageFileWithModelParams): Promise<ImageDescriptionResult>;
declare function extractStructuredWithModel(params: ExtractStructuredWithModelParams): Promise<StructuredExtractionResult>;
declare function describeVideoFile(params: DescribeVideoFileParams): Promise<RunMediaUnderstandingFileResult>;
declare function transcribeAudioFile(params: TranscribeAudioFileParams): Promise<RunMediaUnderstandingFileResult>;
//#endregion
export { runMediaUnderstandingFile as a, extractStructuredWithModel as i, describeImageFileWithModel as n, transcribeAudioFile as o, describeVideoFile as r, describeImageFile as t };