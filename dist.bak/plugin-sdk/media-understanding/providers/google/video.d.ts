import type { VideoDescriptionRequest, VideoDescriptionResult } from "../../types.js";
export declare const DEFAULT_GOOGLE_VIDEO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export declare function describeGeminiVideo(params: VideoDescriptionRequest): Promise<VideoDescriptionResult>;
