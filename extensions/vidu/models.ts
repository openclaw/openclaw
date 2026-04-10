export const VIDU_BASE_URL = "https://api.vidu.com";
export const VIDU_CN_BASE_URL = "https://api.vidu.cn";
export const VIDU_DEFAULT_MODEL = "viduq3-pro";

/** Models that support text-to-video (`/ent/v2/text2video`). */
export const VIDU_TEXT2VIDEO_MODELS = new Set(["viduq3-pro", "viduq3-turbo", "viduq2", "viduq1"]);

/** Models that support image-to-video (`/ent/v2/img2video`). */
export const VIDU_IMG2VIDEO_MODELS = new Set([
  "viduq3-pro",
  "viduq3-turbo",
  "viduq2-pro",
  "viduq2-pro-fast",
  "viduq2-turbo",
  "viduq1",
  "viduq1-classic",
  "vidu2.0",
]);

/** Models that support reference-to-video (`/ent/v2/reference2video`). */
export const VIDU_REFERENCE2VIDEO_MODELS = new Set(["viduq2-pro", "viduq2", "viduq1", "vidu2.0"]);

/** Models that support start-end-to-video (`/ent/v2/start-end2video`). */
export const VIDU_STARTEND2VIDEO_MODELS = new Set([
  "viduq3-pro",
  "viduq3-turbo",
  "viduq2-pro",
  "viduq2-pro-fast",
  "viduq2-turbo",
  "viduq1",
  "viduq1-classic",
  "vidu2.0",
]);

/** Models that support video reference input in reference2video. */
export const VIDU_VIDEO_REFERENCE_MODELS = new Set(["viduq2-pro"]);
