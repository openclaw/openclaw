import type {
  VideoGenerationModeCapabilities,
  VideoGenerationProviderCapabilities,
  VideoGenerationRequest,
} from "openclaw/plugin-sdk/video-generation";

type ModelInput = {
  durations?: readonly number[];
  numericDuration?: boolean;
  aspectRatios?: readonly string[];
  resolutions?: readonly string[];
  uppercaseResolution?: boolean;
  audioField?: "sound" | "generate_audio";
  imageField?: "image_urls" | "image_url" | "input_urls";
  maxPromptLength: number;
  minPromptLength?: number;
};

type ModelFamily = {
  textModel?: string;
  imageModel: string;
  text?: ModelInput;
  image: ModelInput;
};

const KLING: ModelInput = {
  durations: [5, 10],
  audioField: "sound",
  maxPromptLength: 1000,
};
const GROK: ModelInput = {
  durations: Array.from({ length: 25 }, (_, index) => index + 6),
  resolutions: ["480P", "720P", "1080P"],
  maxPromptLength: 5000,
};
const WAN: ModelInput = {
  durations: [5, 10, 15],
  resolutions: ["1080P", "720P"],
  maxPromptLength: 5000,
};
const HAILUO: ModelInput = { maxPromptLength: 1500 };
const HAILUO_23: ModelInput = {
  durations: [6, 10],
  resolutions: ["768P", "1080P"],
  uppercaseResolution: true,
  imageField: "image_url",
  maxPromptLength: 5000,
};
const SEEDANCE: ModelInput = {
  durations: Array.from({ length: 9 }, (_, index) => index + 4),
  numericDuration: true,
  resolutions: ["720P", "480P", "1080P"],
  aspectRatios: ["16:9", "1:1", "4:3", "3:4", "9:16", "21:9"],
  audioField: "generate_audio",
  maxPromptLength: 20000,
  minPromptLength: 3,
};

// Each family owns both routing and the input contract used for capability discovery.
export const KIE_VIDEO_FAMILIES: readonly ModelFamily[] = [
  {
    textModel: "kling-2.6/text-to-video",
    imageModel: "kling-2.6/image-to-video",
    text: { ...KLING, aspectRatios: ["16:9", "1:1", "9:16"] },
    image: { ...KLING, imageField: "image_urls" },
  },
  {
    textModel: "grok-imagine/text-to-video",
    imageModel: "grok-imagine/image-to-video",
    text: {
      ...GROK,
      numericDuration: true,
      aspectRatios: ["16:9", "2:3", "3:2", "1:1", "9:16"],
    },
    image: { ...GROK, imageField: "image_urls" },
  },
  {
    textModel: "wan/2-6-text-to-video",
    imageModel: "wan/2-6-image-to-video",
    text: WAN,
    image: { ...WAN, imageField: "image_urls", minPromptLength: 2 },
  },
  {
    textModel: "hailuo/02-text-to-video-standard",
    imageModel: "hailuo/02-image-to-video-standard",
    text: { ...HAILUO, durations: [6, 10] },
    image: {
      ...HAILUO,
      durations: [6, 10],
      resolutions: ["768P", "512P"],
      uppercaseResolution: true,
      imageField: "image_url",
    },
  },
  {
    textModel: "hailuo/02-text-to-video-pro",
    imageModel: "hailuo/02-image-to-video-pro",
    text: HAILUO,
    image: { ...HAILUO, imageField: "image_url" },
  },
  { imageModel: "hailuo/2-3-image-to-video-standard", image: HAILUO_23 },
  { imageModel: "hailuo/2-3-image-to-video-pro", image: HAILUO_23 },
  {
    textModel: "bytedance/seedance-1.5-pro",
    imageModel: "bytedance/seedance-1.5-pro",
    text: SEEDANCE,
    image: { ...SEEDANCE, imageField: "input_urls" },
  },
];

export const DEFAULT_KIE_VIDEO_MODEL = "kling-2.6/text-to-video";

export function findKieVideoFamily(model: string): ModelFamily {
  const family = KIE_VIDEO_FAMILIES.find(
    (entry) => entry.textModel === model || entry.imageModel === model,
  );
  if (!family) {
    throw new Error(`Kie AI video generation does not support model ${model}.`);
  }
  return family;
}

function modeCapabilities(input?: ModelInput): VideoGenerationModeCapabilities {
  return {
    maxVideos: 1,
    maxDurationSeconds: input?.durations ? Math.max(...input.durations) : undefined,
    supportedDurationSeconds: input?.durations ?? [],
    aspectRatios: input?.aspectRatios ?? [],
    resolutions: input?.resolutions ?? [],
    supportsAspectRatio: Boolean(input?.aspectRatios),
    supportsResolution: Boolean(input?.resolutions),
    supportsAudio: Boolean(input?.audioField),
    supportsSize: false,
    supportsWatermark: false,
    providerOptions: {},
  };
}

export function kieVideoCapabilities(family: ModelFamily): VideoGenerationProviderCapabilities {
  return {
    generate: modeCapabilities(family.text),
    imageToVideo: { ...modeCapabilities(family.image), enabled: true, maxInputImages: 1 },
    videoToVideo: { enabled: false },
  };
}

export function prepareKieVideoRequest(req: VideoGenerationRequest) {
  if (req.inputVideos?.length || req.inputAudios?.length) {
    throw new Error("Kie AI video generation does not support video or audio reference inputs.");
  }
  if ((req.inputImages?.length ?? 0) > 1) {
    throw new Error("Kie AI video generation supports at most one input image.");
  }
  const image = req.inputImages?.[0];
  if (image?.role && image.role !== "first_frame") {
    throw new Error("Kie AI image-to-video supports only an ordinary or first_frame image.");
  }
  const family = findKieVideoFamily(req.model.trim() || DEFAULT_KIE_VIDEO_MODEL);
  const spec = image ? family.image : family.text;
  const model = image ? family.imageModel : family.textModel;
  if (!spec || !model) {
    throw new Error(`Kie AI model ${req.model} requires one input image.`);
  }
  const minPromptLength = spec.minPromptLength ?? 1;
  if (req.prompt.trim().length < minPromptLength || req.prompt.length > spec.maxPromptLength) {
    throw new Error(
      `Kie AI ${model} requires a prompt of ${minPromptLength}-${spec.maxPromptLength} characters.`,
    );
  }
  const input: Record<string, unknown> = { prompt: req.prompt };
  if (spec.durations?.length) {
    const requested = req.durationSeconds;
    const duration =
      typeof requested === "number" && Number.isFinite(requested)
        ? spec.durations.reduce((best, next) =>
            Math.abs(next - requested) < Math.abs(best - requested) ? next : best,
          )
        : spec.durations[0];
    input.duration = spec.numericDuration ? duration : String(duration);
  }
  if (spec.aspectRatios) {
    input.aspect_ratio = spec.aspectRatios.includes(req.aspectRatio ?? "")
      ? req.aspectRatio
      : spec.aspectRatios[0];
  }
  if (spec.resolutions) {
    const requested = req.resolution?.toUpperCase();
    const resolution = spec.resolutions.find((value) => value === requested) ?? spec.resolutions[0];
    input.resolution = spec.uppercaseResolution ? resolution : resolution?.toLowerCase();
    if (model.startsWith("hailuo/2-3-") && resolution === "1080P" && input.duration === "10") {
      throw new Error(
        "Kie AI Hailuo 2.3 supports 1080P only at 6 seconds; use 768P for 10 seconds.",
      );
    }
  }
  if (spec.audioField) {
    input[spec.audioField] = req.audio ?? false;
  }
  return { model, input, image, imageField: spec.imageField };
}
