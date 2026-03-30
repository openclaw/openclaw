import type { VideoDescriptionRequest, VideoDescriptionResult } from "../../types.js";
export declare const DEFAULT_MOONSHOT_VIDEO_BASE_URL = "https://api.moonshot.ai/v1";
export declare function describeMoonshotVideo(params: VideoDescriptionRequest): Promise<VideoDescriptionResult>;
