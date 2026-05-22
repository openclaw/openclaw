import type { DescribeImageFileParams, DescribeImageFileWithModelParams, DescribeVideoFileParams, RunMediaUnderstandingFileParams, RunMediaUnderstandingFileResult, TranscribeAudioFileParams } from "./runtime-types.js";
export type { DescribeImageFileParams, DescribeImageFileWithModelParams, DescribeVideoFileParams, RunMediaUnderstandingFileParams, RunMediaUnderstandingFileResult, TranscribeAudioFileParams, } from "./runtime-types.js";
export declare function runMediaUnderstandingFile(params: RunMediaUnderstandingFileParams): Promise<RunMediaUnderstandingFileResult>;
export declare function describeImageFile(params: DescribeImageFileParams): Promise<RunMediaUnderstandingFileResult>;
export declare function describeImageFileWithModel(params: DescribeImageFileWithModelParams): Promise<import("openclaw/plugin-sdk/media-understanding").ImageDescriptionResult>;
export declare function describeVideoFile(params: DescribeVideoFileParams): Promise<RunMediaUnderstandingFileResult>;
export declare function transcribeAudioFile(params: TranscribeAudioFileParams): Promise<RunMediaUnderstandingFileResult>;
