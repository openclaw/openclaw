// extensions/atlascloud/model-schemas.ts
// Per-model schema table for Atlas Cloud video generation.
//
// Data sources:
//   1) Entries with `verified: true` were captured directly from
//      Atlas Cloud's `/api/v1/models/{id}` endpoint (Veo3.1 t2v/i2v,
//      Kling v3.0 Pro t2v/i2v, Seedance v1.5 Pro t2v, Wan 2.6 v2v,
//      Wan 2.7 t2v, Vidu Q3 r2v / Q3-Pro t2v, Sora-2 t2v/i2v,
//      Hailuo 2.3 t2v-pro/i2v-pro).
//   2) Entries with `verified: false` are extrapolated from a sibling
//      verified schema in the same family + mode. The CI refresher
//      (`scripts/refresh-schemas.ts`) periodically pulls fresh schemas
//      from the Atlas Cloud OpenAPI and overrides these defaults.

// =============================================================================
// Types
// =============================================================================

export type AtlasFamily =
  | "google-veo"
  | "kuaishou-kling"
  | "bytedance-seedance"
  | "alibaba-wan"
  | "vidu"
  | "openai-sora"
  | "minimax-hailuo"
  | "generic";

export type AtlasMode =
  | "text-to-video"
  | "image-to-video"
  | "video-to-video"
  | "reference-to-video"
  | "start-end-frame"
  | "video-edit"
  | "other";

/** Maps a generic OpenClaw request concept onto the model's actual body field. */
export type FieldRule<T extends string = string> = { name: T };

export type AspectRatioRule = FieldRule;
export type ResolutionRule = FieldRule & { case: "lower" | "upper" };
export type SizeRule = FieldRule & { sep: "x" | "*" };
export type DurationRule = FieldRule;
export type AudioRule = FieldRule & { type: "boolean" | "url" };
export type ImageRule =
  | (FieldRule & { multi: false })
  | (FieldRule & { multi: true; max: number });
export type VideoRule = FieldRule & { multi: boolean };
export type SeedRule = FieldRule & { randomSentinel?: number };
export type NegativePromptRule = FieldRule;

/** Full schema for one model: field mapping + value ranges + defaults. */
export type AtlasModelSchema = {
  family: AtlasFamily;
  mode: AtlasMode;
  fields: {
    aspectRatio?: AspectRatioRule;
    resolution?: ResolutionRule;
    size?: SizeRule;
    duration?: DurationRule;
    audio?: AudioRule;
    image?: ImageRule;
    /** End-frame image field (image-to-video only). */
    endImage?: FieldRule;
    video?: VideoRule;
    seed?: SeedRule;
    negativePrompt?: NegativePromptRule;
  };
  options?: {
    aspectRatios?: readonly string[];
    resolutions?: readonly string[];
    sizes?: readonly string[];
    durations?: readonly number[];
  };
  defaults?: Readonly<Record<string, unknown>>;
  verified?: boolean;
};

// =============================================================================
// 7 family baselines
// =============================================================================

export const FAMILY_BASELINES: Record<AtlasFamily, AtlasModelSchema> = {
  "google-veo": {
    family: "google-veo",
    mode: "other",
    fields: {
      aspectRatio: { name: "aspect_ratio" },
      resolution: { name: "resolution", case: "lower" },
      duration: { name: "duration" },
      audio: { name: "generate_audio", type: "boolean" },
      seed: { name: "seed" },
      negativePrompt: { name: "negative_prompt" },
    },
    options: {
      aspectRatios: ["16:9", "9:16"],
      resolutions: ["720p", "1080p"],
      durations: [4, 6, 8],
    },
  },
  "kuaishou-kling": {
    family: "kuaishou-kling",
    mode: "other",
    fields: {
      duration: { name: "duration" },
      audio: { name: "sound", type: "boolean" },
      negativePrompt: { name: "negative_prompt" },
    },
    options: { durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
    defaults: { cfg_scale: 0.5, sound: true },
  },
  "bytedance-seedance": {
    family: "bytedance-seedance",
    mode: "other",
    fields: {
      aspectRatio: { name: "aspect_ratio" },
      resolution: { name: "resolution", case: "lower" },
      duration: { name: "duration" },
      audio: { name: "generate_audio", type: "boolean" },
      seed: { name: "seed", randomSentinel: -1 },
    },
    options: {
      aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
      resolutions: ["480p", "720p"],
    },
    defaults: { camera_fixed: false, seed: -1 },
  },
  "alibaba-wan": {
    family: "alibaba-wan",
    mode: "other",
    fields: {
      duration: { name: "duration" },
      seed: { name: "seed", randomSentinel: -1 },
      negativePrompt: { name: "negative_prompt" },
    },
    defaults: { enable_prompt_expansion: true, seed: -1 },
  },
  vidu: {
    family: "vidu",
    mode: "other",
    fields: {
      aspectRatio: { name: "aspect_ratio" },
      resolution: { name: "resolution", case: "lower" },
      duration: { name: "duration" },
      audio: { name: "generate_audio", type: "boolean" },
      seed: { name: "seed", randomSentinel: -1 },
    },
    options: {
      aspectRatios: ["16:9", "9:16", "3:4", "4:3", "1:1"],
      resolutions: ["540p", "720p", "1080p"],
    },
    defaults: { movement_amplitude: "auto", generate_audio: true },
  },
  "openai-sora": {
    family: "openai-sora",
    mode: "other",
    fields: {
      size: { name: "size", sep: "x" },
      duration: { name: "duration" },
    },
    options: {
      sizes: ["720x1280", "1280x720"],
      durations: [4, 8, 12],
    },
  },
  "minimax-hailuo": {
    family: "minimax-hailuo",
    mode: "other",
    fields: {},
    defaults: { enable_prompt_expansion: true },
  },
  generic: {
    family: "generic",
    mode: "other",
    fields: {
      aspectRatio: { name: "aspect_ratio" },
      resolution: { name: "resolution", case: "lower" },
      duration: { name: "duration" },
      seed: { name: "seed" },
      negativePrompt: { name: "negative_prompt" },
    },
  },
};

// =============================================================================
// 64 per-model overrides
// =============================================================================

export const MODEL_OVERRIDES: Readonly<Record<string, Partial<AtlasModelSchema>>> = {
  // ---------------- Google Veo (8) ----------------
  "google/veo3.1/text-to-video": {
    family: "google-veo",
    mode: "text-to-video",
    verified: true,
    defaults: { generate_audio: false, aspect_ratio: "16:9", duration: 4, resolution: "1080p" },
  },
  "google/veo3.1/image-to-video": {
    family: "google-veo",
    mode: "image-to-video",
    verified: true,
    fields: {
      aspectRatio: { name: "aspect_ratio" },
      resolution: { name: "resolution", case: "lower" },
      duration: { name: "duration" },
      audio: { name: "generate_audio", type: "boolean" },
      seed: { name: "seed" },
      negativePrompt: { name: "negative_prompt" },
      image: { name: "image", multi: false },
      endImage: { name: "last_image" },
    },
    defaults: { generate_audio: false, aspect_ratio: "16:9", duration: 4, resolution: "1080p" },
  },
  "google/veo3.1/reference-to-video": {
    family: "google-veo",
    mode: "reference-to-video",
    fields: {
      aspectRatio: { name: "aspect_ratio" },
      resolution: { name: "resolution", case: "lower" },
      duration: { name: "duration" },
      audio: { name: "generate_audio", type: "boolean" },
      seed: { name: "seed" },
      negativePrompt: { name: "negative_prompt" },
      image: { name: "images", multi: true, max: 3 },
    },
  },
  "google/veo3.1-fast/text-to-video": {
    family: "google-veo",
    mode: "text-to-video",
    defaults: { generate_audio: false, duration: 4, resolution: "720p" },
  },
  "google/veo3.1-fast/image-to-video": {
    family: "google-veo",
    mode: "image-to-video",
    fields: {
      aspectRatio: { name: "aspect_ratio" },
      resolution: { name: "resolution", case: "lower" },
      duration: { name: "duration" },
      audio: { name: "generate_audio", type: "boolean" },
      seed: { name: "seed" },
      negativePrompt: { name: "negative_prompt" },
      image: { name: "image", multi: false },
      endImage: { name: "last_image" },
    },
  },
  "google/veo3.1-lite/text-to-video": {
    family: "google-veo",
    mode: "text-to-video",
    options: { resolutions: ["720p"], durations: [4, 6, 8] },
    defaults: { generate_audio: false, resolution: "720p" },
  },
  "google/veo3.1-lite/image-to-video": {
    family: "google-veo",
    mode: "image-to-video",
    fields: {
      aspectRatio: { name: "aspect_ratio" },
      resolution: { name: "resolution", case: "lower" },
      duration: { name: "duration" },
      audio: { name: "generate_audio", type: "boolean" },
      seed: { name: "seed" },
      image: { name: "image", multi: false },
      endImage: { name: "last_image" },
    },
    options: { resolutions: ["720p"] },
  },
  "google/veo3.1-lite/start-end-frame-to-video": {
    family: "google-veo",
    mode: "start-end-frame",
    fields: {
      duration: { name: "duration" },
      audio: { name: "generate_audio", type: "boolean" },
      image: { name: "image", multi: false },
      endImage: { name: "last_image" },
    },
  },

  // ---------------- Kuaishou Kling (16) ----------------
  "kwaivgi/kling-v3.0-pro/text-to-video": {
    family: "kuaishou-kling",
    mode: "text-to-video",
    verified: true,
    fields: {
      duration: { name: "duration" },
      audio: { name: "sound", type: "boolean" },
      negativePrompt: { name: "negative_prompt" },
      aspectRatio: { name: "aspect_ratio" },
    },
    options: { aspectRatios: ["16:9", "9:16", "1:1"] },
    defaults: { cfg_scale: 0.5, sound: true, duration: 5, aspect_ratio: "16:9" },
  },
  "kwaivgi/kling-v3.0-pro/image-to-video": {
    family: "kuaishou-kling",
    mode: "image-to-video",
    verified: true,
    fields: {
      duration: { name: "duration" },
      audio: { name: "sound", type: "boolean" },
      negativePrompt: { name: "negative_prompt" },
      image: { name: "image", multi: false },
      endImage: { name: "end_image" },
    },
    defaults: { cfg_scale: 0.5, sound: true, duration: 5 },
  },
  "kwaivgi/kling-v3.0-std/text-to-video": {
    family: "kuaishou-kling",
    mode: "text-to-video",
    fields: {
      duration: { name: "duration" },
      audio: { name: "sound", type: "boolean" },
      negativePrompt: { name: "negative_prompt" },
      aspectRatio: { name: "aspect_ratio" },
    },
    options: { aspectRatios: ["16:9", "9:16", "1:1"] },
  },
  "kwaivgi/kling-v3.0-std/image-to-video": {
    family: "kuaishou-kling",
    mode: "image-to-video",
    fields: {
      duration: { name: "duration" },
      audio: { name: "sound", type: "boolean" },
      negativePrompt: { name: "negative_prompt" },
      image: { name: "image", multi: false },
      endImage: { name: "end_image" },
    },
  },
  "kwaivgi/kling-v2.6-pro/text-to-video": {
    family: "kuaishou-kling",
    mode: "text-to-video",
    fields: {
      duration: { name: "duration" },
      audio: { name: "sound", type: "boolean" },
      aspectRatio: { name: "aspect_ratio" },
    },
  },
  "kwaivgi/kling-v2.6-pro/image-to-video": {
    family: "kuaishou-kling",
    mode: "image-to-video",
    fields: {
      duration: { name: "duration" },
      audio: { name: "sound", type: "boolean" },
      image: { name: "image", multi: false },
      endImage: { name: "end_image" },
    },
  },
  "kwaivgi/kling-v2.5-turbo-pro/text-to-video": {
    family: "kuaishou-kling",
    mode: "text-to-video",
    fields: { duration: { name: "duration" }, aspectRatio: { name: "aspect_ratio" } },
  },
  "kwaivgi/kling-v2.5-turbo-pro/image-to-video": {
    family: "kuaishou-kling",
    mode: "image-to-video",
    fields: { duration: { name: "duration" }, image: { name: "image", multi: false } },
  },
  "kwaivgi/kling-v2.1-i2v-pro": {
    family: "kuaishou-kling",
    mode: "image-to-video",
    fields: { duration: { name: "duration" }, image: { name: "image", multi: false } },
  },
  "kwaivgi/kling-v2.1-t2v-master": {
    family: "kuaishou-kling",
    mode: "text-to-video",
    fields: { duration: { name: "duration" }, aspectRatio: { name: "aspect_ratio" } },
  },
  "kwaivgi/kling-v2.1-i2v-master": {
    family: "kuaishou-kling",
    mode: "image-to-video",
    fields: { duration: { name: "duration" }, image: { name: "image", multi: false } },
  },
  "kwaivgi/kling-v1.6-i2v-pro": {
    family: "kuaishou-kling",
    mode: "image-to-video",
    fields: { duration: { name: "duration" }, image: { name: "image", multi: false } },
  },
  "kwaivgi/kling-video-o3-pro/text-to-video": {
    family: "kuaishou-kling",
    mode: "text-to-video",
    fields: { duration: { name: "duration" }, aspectRatio: { name: "aspect_ratio" } },
  },
  "kwaivgi/kling-video-o3-pro/image-to-video": {
    family: "kuaishou-kling",
    mode: "image-to-video",
    fields: { duration: { name: "duration" }, image: { name: "image", multi: false } },
  },
  "kwaivgi/kling-video-o3-pro/reference-to-video": {
    family: "kuaishou-kling",
    mode: "reference-to-video",
    fields: { duration: { name: "duration" }, image: { name: "images", multi: true, max: 4 } },
  },
  "kwaivgi/kling-video-o3-pro/video-edit": {
    family: "kuaishou-kling",
    mode: "video-edit",
    fields: { video: { name: "video", multi: false } },
  },
  "kwaivgi/kling-v2.6-pro/avatar": {
    family: "kuaishou-kling",
    mode: "image-to-video",
    fields: { image: { name: "image", multi: false } },
  },

  // ---------------- ByteDance Seedance (12) ----------------
  "bytedance/seedance-v1.5-pro/text-to-video": {
    family: "bytedance-seedance",
    mode: "text-to-video",
    verified: true,
    defaults: {
      generate_audio: true,
      camera_fixed: false,
      seed: -1,
      duration: 5,
      resolution: "720p",
    },
  },
  "bytedance/seedance-v1.5-pro/image-to-video": {
    family: "bytedance-seedance",
    mode: "image-to-video",
    fields: {
      aspectRatio: { name: "aspect_ratio" },
      resolution: { name: "resolution", case: "lower" },
      duration: { name: "duration" },
      audio: { name: "generate_audio", type: "boolean" },
      seed: { name: "seed", randomSentinel: -1 },
      image: { name: "image", multi: false },
      endImage: { name: "last_image" },
    },
    defaults: { generate_audio: true, camera_fixed: false, seed: -1 },
  },
  "bytedance/seedance-v1.5-pro/text-to-video-fast": {
    family: "bytedance-seedance",
    mode: "text-to-video",
  },
  "bytedance/seedance-v1.5-pro/image-to-video-fast": {
    family: "bytedance-seedance",
    mode: "image-to-video",
    fields: {
      aspectRatio: { name: "aspect_ratio" },
      resolution: { name: "resolution", case: "lower" },
      duration: { name: "duration" },
      audio: { name: "generate_audio", type: "boolean" },
      seed: { name: "seed", randomSentinel: -1 },
      image: { name: "image", multi: false },
      endImage: { name: "last_image" },
    },
  },
  "bytedance/seedance-v1.5-pro/image-to-video-spicy": {
    family: "bytedance-seedance",
    mode: "image-to-video",
    fields: {
      aspectRatio: { name: "aspect_ratio" },
      resolution: { name: "resolution", case: "lower" },
      duration: { name: "duration" },
      audio: { name: "generate_audio", type: "boolean" },
      seed: { name: "seed", randomSentinel: -1 },
      image: { name: "image", multi: false },
    },
  },
  "bytedance/seedance-v1-pro-fast/text-to-video": {
    family: "bytedance-seedance",
    mode: "text-to-video",
  },
  "bytedance/seedance-v1-pro-fast/image-to-video": {
    family: "bytedance-seedance",
    mode: "image-to-video",
    fields: {
      aspectRatio: { name: "aspect_ratio" },
      resolution: { name: "resolution", case: "lower" },
      duration: { name: "duration" },
      audio: { name: "generate_audio", type: "boolean" },
      seed: { name: "seed", randomSentinel: -1 },
      image: { name: "image", multi: false },
    },
  },
  "bytedance/seedance-v1-pro-t2v-1080p": {
    family: "bytedance-seedance",
    mode: "text-to-video",
    options: { resolutions: ["1080p"] },
    defaults: { resolution: "1080p" },
  },
  "bytedance/seedance-v1-pro-t2v-720p": {
    family: "bytedance-seedance",
    mode: "text-to-video",
    options: { resolutions: ["720p"] },
    defaults: { resolution: "720p" },
  },
  "bytedance/seedance-v1-pro-i2v-1080p": {
    family: "bytedance-seedance",
    mode: "image-to-video",
    fields: {
      aspectRatio: { name: "aspect_ratio" },
      resolution: { name: "resolution", case: "lower" },
      duration: { name: "duration" },
      audio: { name: "generate_audio", type: "boolean" },
      seed: { name: "seed", randomSentinel: -1 },
      image: { name: "image", multi: false },
    },
    options: { resolutions: ["1080p"] },
    defaults: { resolution: "1080p" },
  },
  "bytedance/seedance-v1-lite-t2v-720p": {
    family: "bytedance-seedance",
    mode: "text-to-video",
    options: { resolutions: ["720p"] },
  },
  "bytedance/seedance-v1-lite-i2v-720p": {
    family: "bytedance-seedance",
    mode: "image-to-video",
    fields: {
      aspectRatio: { name: "aspect_ratio" },
      resolution: { name: "resolution", case: "lower" },
      duration: { name: "duration" },
      audio: { name: "generate_audio", type: "boolean" },
      image: { name: "image", multi: false },
    },
    options: { resolutions: ["720p"] },
  },

  // ---------------- Alibaba Wan (10) ----------------
  // NOTE: Wan 2.7 and Wan 2.6 use very different field names; they MUST be
  // overridden separately. Do not assume family-level commonality here.
  "alibaba/wan-2.7/text-to-video": {
    family: "alibaba-wan",
    mode: "text-to-video",
    verified: true,
    fields: {
      // Wan 2.7 uses `ratio`, not `aspect_ratio`.
      aspectRatio: { name: "ratio" },
      // Wan 2.7 uses uppercase `1080P` / `720P`.
      resolution: { name: "resolution", case: "upper" },
      duration: { name: "duration" },
      // NOTE: Wan 2.7 `audio` is a URL string, not a boolean. The boolean
      // `req.audio` cannot express that — pass via extraParams instead.
      seed: { name: "seed", randomSentinel: -1 },
      negativePrompt: { name: "negative_prompt" },
    },
    options: {
      aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
      resolutions: ["720P", "1080P"],
    },
    defaults: {
      prompt_extend: true,
      seed: -1,
      ratio: "16:9",
      resolution: "1080P",
      duration: 5,
    },
  },
  "alibaba/wan-2.7/image-to-video": {
    family: "alibaba-wan",
    mode: "image-to-video",
    fields: {
      aspectRatio: { name: "ratio" },
      resolution: { name: "resolution", case: "upper" },
      duration: { name: "duration" },
      seed: { name: "seed", randomSentinel: -1 },
      negativePrompt: { name: "negative_prompt" },
      image: { name: "image", multi: false },
    },
    options: { resolutions: ["720P", "1080P"] },
    defaults: { prompt_extend: true, seed: -1 },
  },
  "alibaba/wan-2.7/reference-to-video": {
    family: "alibaba-wan",
    mode: "reference-to-video",
    fields: {
      duration: { name: "duration" },
      seed: { name: "seed", randomSentinel: -1 },
      image: { name: "images", multi: true, max: 4 },
    },
  },
  "alibaba/wan-2.7/video-edit": {
    family: "alibaba-wan",
    mode: "video-edit",
    fields: {
      duration: { name: "duration" },
      seed: { name: "seed", randomSentinel: -1 },
      video: { name: "video", multi: false },
    },
  },
  "alibaba/wan-2.6/text-to-video": {
    family: "alibaba-wan",
    mode: "text-to-video",
    fields: {
      duration: { name: "duration" },
      seed: { name: "seed", randomSentinel: -1 },
      negativePrompt: { name: "negative_prompt" },
      // Wan 2.6 uses `size` with `*` separator.
      size: { name: "size", sep: "*" },
    },
    options: {
      sizes: [
        "1280*720",
        "720*1280",
        "960*960",
        "1088*832",
        "832*1088",
        "1920*1080",
        "1080*1920",
      ],
      durations: [5, 10],
    },
    defaults: { enable_prompt_expansion: true, seed: -1, size: "1280*720", duration: 5 },
  },
  "alibaba/wan-2.6/image-to-video": {
    family: "alibaba-wan",
    mode: "image-to-video",
    fields: {
      duration: { name: "duration" },
      seed: { name: "seed", randomSentinel: -1 },
      negativePrompt: { name: "negative_prompt" },
      size: { name: "size", sep: "*" },
      image: { name: "image", multi: false },
    },
    options: { durations: [5, 10] },
    defaults: { enable_prompt_expansion: true, seed: -1 },
  },
  "alibaba/wan-2.6/video-to-video": {
    family: "alibaba-wan",
    mode: "video-to-video",
    verified: true,
    fields: {
      duration: { name: "duration" },
      seed: { name: "seed", randomSentinel: -1 },
      negativePrompt: { name: "negative_prompt" },
      size: { name: "size", sep: "*" },
      video: { name: "videos", multi: true },
    },
    options: {
      sizes: [
        "1280*720",
        "720*1280",
        "960*960",
        "1088*832",
        "832*1088",
        "1920*1080",
        "1080*1920",
      ],
      durations: [5, 10],
    },
    defaults: { enable_prompt_expansion: true, shot_type: "multi", seed: -1, size: "1280*720" },
  },
  "alibaba/wan-2.6/image-to-video-flash": {
    family: "alibaba-wan",
    mode: "image-to-video",
    fields: {
      duration: { name: "duration" },
      seed: { name: "seed", randomSentinel: -1 },
      size: { name: "size", sep: "*" },
      image: { name: "image", multi: false },
    },
  },
  "alibaba/wan-2.5/text-to-video": {
    family: "alibaba-wan",
    mode: "text-to-video",
    fields: {
      duration: { name: "duration" },
      seed: { name: "seed", randomSentinel: -1 },
      negativePrompt: { name: "negative_prompt" },
      size: { name: "size", sep: "*" },
    },
  },
  "alibaba/wan-2.5/image-to-video": {
    family: "alibaba-wan",
    mode: "image-to-video",
    fields: {
      duration: { name: "duration" },
      seed: { name: "seed", randomSentinel: -1 },
      size: { name: "size", sep: "*" },
      image: { name: "image", multi: false },
    },
  },

  // ---------------- Vidu (10) ----------------
  "vidu/q3/reference-to-video": {
    family: "vidu",
    mode: "reference-to-video",
    verified: true,
    fields: {
      aspectRatio: { name: "aspect_ratio" },
      resolution: { name: "resolution", case: "lower" },
      duration: { name: "duration" },
      audio: { name: "generate_audio", type: "boolean" },
      seed: { name: "seed", randomSentinel: -1 },
      image: { name: "images", multi: true, max: 4 },
    },
    defaults: { movement_amplitude: "auto", generate_audio: true, aspect_ratio: "16:9" },
  },
  "vidu/q3-pro/text-to-video": {
    family: "vidu",
    mode: "text-to-video",
    verified: true,
    fields: {
      aspectRatio: { name: "aspect_ratio" },
      resolution: { name: "resolution", case: "lower" },
      duration: { name: "duration" },
      audio: { name: "generate_audio", type: "boolean" },
      seed: { name: "seed", randomSentinel: -1 },
    },
    options: {
      aspectRatios: ["16:9", "9:16", "4:3", "3:4", "1:1"],
      resolutions: ["540p", "720p", "1080p"],
    },
    defaults: {
      style: "general",
      movement_amplitude: "auto",
      generate_audio: true,
      bgm: true,
      duration: 5,
      aspect_ratio: "4:3",
    },
  },
  "vidu/q3-pro/image-to-video": {
    family: "vidu",
    mode: "image-to-video",
    fields: {
      aspectRatio: { name: "aspect_ratio" },
      resolution: { name: "resolution", case: "lower" },
      duration: { name: "duration" },
      audio: { name: "generate_audio", type: "boolean" },
      image: { name: "image", multi: false },
    },
  },
  "vidu/q3-pro/start-end-to-video": {
    family: "vidu",
    mode: "start-end-frame",
    fields: {
      duration: { name: "duration" },
      audio: { name: "generate_audio", type: "boolean" },
      image: { name: "image", multi: false },
      endImage: { name: "last_image" },
    },
  },
  "vidu/q3-turbo/text-to-video": {
    family: "vidu",
    mode: "text-to-video",
    options: { resolutions: ["540p", "720p"] },
  },
  "vidu/q3-turbo/image-to-video": {
    family: "vidu",
    mode: "image-to-video",
    fields: {
      aspectRatio: { name: "aspect_ratio" },
      resolution: { name: "resolution", case: "lower" },
      duration: { name: "duration" },
      image: { name: "image", multi: false },
    },
    options: { resolutions: ["540p", "720p"] },
  },
  "vidu/q3-mix/reference-to-video": {
    family: "vidu",
    mode: "reference-to-video",
    fields: {
      aspectRatio: { name: "aspect_ratio" },
      resolution: { name: "resolution", case: "lower" },
      duration: { name: "duration" },
      image: { name: "images", multi: true, max: 4 },
    },
  },
  "vidu/q2-pro-fast/reference-to-video": {
    family: "vidu",
    mode: "reference-to-video",
    fields: { duration: { name: "duration" }, image: { name: "images", multi: true, max: 4 } },
  },
  "vidu/q2-pro-fast/reference-to-video-with-audio": {
    family: "vidu",
    mode: "reference-to-video",
    fields: {
      duration: { name: "duration" },
      audio: { name: "generate_audio", type: "boolean" },
      image: { name: "images", multi: true, max: 4 },
    },
  },
  "vidu/reference-to-video-q1": {
    family: "vidu",
    mode: "reference-to-video",
    fields: { image: { name: "images", multi: true, max: 4 } },
  },

  // ---------------- OpenAI Sora (2) ----------------
  "openai/sora-2/text-to-video": {
    family: "openai-sora",
    mode: "text-to-video",
    verified: true,
    defaults: { duration: 4, size: "720x1280" },
  },
  "openai/sora-2/image-to-video": {
    family: "openai-sora",
    mode: "image-to-video",
    verified: true,
    fields: {
      size: { name: "size", sep: "x" },
      duration: { name: "duration" },
      image: { name: "image", multi: false },
    },
    defaults: { duration: 4, size: "720x1280" },
  },

  // ---------------- MiniMax Hailuo (8) ----------------
  "minimax/hailuo-2.3/t2v-pro": {
    family: "minimax-hailuo",
    mode: "text-to-video",
    verified: true,
    defaults: { enable_prompt_expansion: true },
  },
  "minimax/hailuo-2.3/t2v-standard": {
    family: "minimax-hailuo",
    mode: "text-to-video",
  },
  "minimax/hailuo-2.3/i2v-pro": {
    family: "minimax-hailuo",
    mode: "image-to-video",
    verified: true,
    fields: { image: { name: "image", multi: false } },
    defaults: { enable_prompt_expansion: true },
  },
  "minimax/hailuo-2.3/i2v-standard": {
    family: "minimax-hailuo",
    mode: "image-to-video",
    fields: { image: { name: "image", multi: false } },
  },
  "minimax/hailuo-2.3/fast": {
    family: "minimax-hailuo",
    mode: "text-to-video",
  },
  "minimax/hailuo-02/t2v-pro": {
    family: "minimax-hailuo",
    mode: "text-to-video",
  },
  "minimax/hailuo-02/i2v-pro": {
    family: "minimax-hailuo",
    mode: "image-to-video",
    fields: { image: { name: "image", multi: false } },
  },
  "minimax/hailuo-02/fast": {
    family: "minimax-hailuo",
    mode: "text-to-video",
  },
};

// =============================================================================
// Schema resolver
// =============================================================================

function detectFamilyFromId(model: string): AtlasFamily {
  const id = model.toLowerCase();
  if (id.startsWith("google/veo")) return "google-veo";
  if (id.startsWith("kwaivgi/kling")) return "kuaishou-kling";
  if (id.startsWith("bytedance/seedance")) return "bytedance-seedance";
  if (
    id.startsWith("alibaba/wan") ||
    id.startsWith("atlascloud/wan") ||
    id.startsWith("atlascloud/van")
  ) {
    return "alibaba-wan";
  }
  if (id.startsWith("vidu/")) return "vidu";
  if (id.startsWith("openai/sora")) return "openai-sora";
  if (id.startsWith("minimax/hailuo")) return "minimax-hailuo";
  return "generic";
}

function detectModeFromId(model: string): AtlasMode {
  const id = model.toLowerCase();
  if (id.includes("/text-to-video") || id.includes("/t2v")) return "text-to-video";
  if (id.includes("/image-to-video") || id.includes("/i2v")) return "image-to-video";
  if (id.includes("/video-to-video")) return "video-to-video";
  if (id.includes("/reference-to-video") || id.includes("reference-to-video")) {
    return "reference-to-video";
  }
  if (id.includes("/start-end") || id.includes("start-end-frame")) return "start-end-frame";
  if (id.includes("/video-edit")) return "video-edit";
  return "other";
}

/**
 * Resolve the final schema for a model. Override fields/options/defaults are
 * shallow-merged on top of the family baseline. Unregistered models fall back
 * to the family baseline plus generic field detection.
 */
export function resolveAtlasSchema(model: string): AtlasModelSchema {
  const override = MODEL_OVERRIDES[model];
  const family = override?.family ?? detectFamilyFromId(model);
  const mode = override?.mode ?? detectModeFromId(model);
  const baseline = FAMILY_BASELINES[family];

  return {
    family,
    mode,
    verified: override?.verified ?? false,
    fields: { ...baseline.fields, ...(override?.fields ?? {}) },
    options: { ...baseline.options, ...(override?.options ?? {}) },
    defaults: { ...baseline.defaults, ...(override?.defaults ?? {}) },
  };
}

/** Registered model list (used by VideoGenerationProvider.models). */
export const REGISTERED_ATLAS_MODELS: readonly string[] = Object.keys(MODEL_OVERRIDES);
