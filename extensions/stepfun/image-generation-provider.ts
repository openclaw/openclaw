import {
  createOpenAiCompatibleImageGenerationProvider,
  imageSourceUploadFileName,
  type ImageGenerationProvider,
} from "openclaw/plugin-sdk/image-generation";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  STEPFUN_PLAN_INTL_BASE_URL,
  STEPFUN_PLAN_PROVIDER_ID,
  STEPFUN_PROVIDER_ID,
  STEPFUN_STANDARD_INTL_BASE_URL,
} from "./provider-catalog.js";

const DEFAULT_STEPFUN_IMAGE_MODEL = "step-image-edit-2";
const DEFAULT_STEPFUN_IMAGE_SIZE = "1024x1024";
const DEFAULT_TIMEOUT_MS = 180_000;
const STEPFUN_IMAGE_SIZES = ["1024x1024", "768x1360", "896x1184", "1360x768", "1184x896"] as const;

type StepFunImageProviderParams = {
  providerId: string;
  label: string;
  defaultBaseUrl: string;
};

function resolveConfiguredBaseUrl(baseUrl: string | undefined, fallback: string): string {
  return normalizeOptionalString(baseUrl)?.replace(/\/+$/u, "") ?? fallback;
}

function buildStepFunImageProvider(params: StepFunImageProviderParams): ImageGenerationProvider {
  return createOpenAiCompatibleImageGenerationProvider({
    id: params.providerId,
    label: params.label,
    defaultModel: DEFAULT_STEPFUN_IMAGE_MODEL,
    models: [DEFAULT_STEPFUN_IMAGE_MODEL],
    capabilities: {
      generate: {
        maxCount: 1,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: true,
        maxCount: 1,
        maxInputImages: 1,
        supportsSize: false,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: {
        sizes: [...STEPFUN_IMAGE_SIZES],
      },
    },
    defaultBaseUrl: params.defaultBaseUrl,
    resolveBaseUrl: ({ providerConfig, defaultBaseUrl }) =>
      resolveConfiguredBaseUrl(providerConfig?.baseUrl, defaultBaseUrl),
    resolveAllowPrivateNetwork: () => false,
    useConfiguredRequest: true,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    resolveCount: () => 1,
    buildGenerateRequest: ({ req, model, count }) => ({
      kind: "json",
      body: {
        model,
        prompt: req.prompt,
        n: count,
        size: normalizeOptionalString(req.size) ?? DEFAULT_STEPFUN_IMAGE_SIZE,
        response_format: "b64_json",
      },
    }),
    buildEditRequest: ({ req, inputImages, model }) => {
      const image = inputImages[0];
      if (!image) {
        throw new Error("StepFun image edit missing reference image.");
      }
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", req.prompt);
      form.set("response_format", "b64_json");
      const mimeType = normalizeOptionalString(image.mimeType) ?? "image/png";
      form.append(
        "image",
        new Blob([new Uint8Array(image.buffer)], { type: mimeType }),
        imageSourceUploadFileName({ image, index: 0 }),
      );
      return { kind: "multipart", form };
    },
    response: {
      defaultMimeType: "image/png",
      sniffMimeType: true,
    },
    tooManyInputImagesError: "StepFun image editing supports one reference image.",
    missingApiKeyError: `${params.label} API key missing`,
    emptyResponseError: `${params.label} image response did not include generated image data`,
    failureLabels: {
      generate: `${params.label} image generation failed`,
      edit: `${params.label} image edit failed`,
    },
  });
}

export function buildStepFunImageGenerationProvider(): ImageGenerationProvider {
  return buildStepFunImageProvider({
    providerId: STEPFUN_PROVIDER_ID,
    label: "StepFun",
    defaultBaseUrl: STEPFUN_STANDARD_INTL_BASE_URL,
  });
}

export function buildStepFunPlanImageGenerationProvider(): ImageGenerationProvider {
  return buildStepFunImageProvider({
    providerId: STEPFUN_PLAN_PROVIDER_ID,
    label: "StepFun Step Plan",
    defaultBaseUrl: STEPFUN_PLAN_INTL_BASE_URL,
  });
}
