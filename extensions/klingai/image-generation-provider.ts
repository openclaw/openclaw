import type {
  GeneratedImageAsset,
  ImageGenerationProvider,
} from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  downloadKlingBinaryAsset,
  listKlingImageUrls,
  pollKlingTaskUntilComplete,
  resolveKlingHttpConfig,
  submitKlingTask,
  toDataUrl,
} from "./kling-client.js";

const DEFAULT_KLING_IMAGE_MODEL = "kling-v3";
const OMNI_KLING_IMAGE_MODEL = "kling-v3-omni";
const BASIC_IMAGE_ENDPOINT = "/v1/images/generations";
const OMNI_IMAGE_ENDPOINT = "/v1/images/omni-image";
const DEFAULT_IMAGE_ASPECT_RATIO = "16:9";
const DEFAULT_IMAGE_RESOLUTION = "1k";
const SUPPORTED_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
const SUPPORTED_IMAGE_MODELS = [DEFAULT_KLING_IMAGE_MODEL, OMNI_KLING_IMAGE_MODEL] as const;

function mapImageResolution(resolution: "1K" | "2K" | "4K" | undefined): string {
  if (resolution === "4K") {
    return "4k";
  }
  if (resolution === "2K") {
    return "2k";
  }
  return DEFAULT_IMAGE_RESOLUTION;
}

function fileExtensionForMimeType(mimeType: string): string {
  if (mimeType.includes("jpeg")) {
    return "jpg";
  }
  if (mimeType.includes("webp")) {
    return "webp";
  }
  if (mimeType.includes("png")) {
    return "png";
  }
  return "bin";
}

function resolveImageReference(input: { url?: string; buffer: Buffer; mimeType: string }): string {
  const url = normalizeOptionalString(input.url);
  if (url) {
    return url;
  }
  return toDataUrl(input.buffer, input.mimeType);
}

function resolveImageModel(model: string | undefined): (typeof SUPPORTED_IMAGE_MODELS)[number] {
  const normalized = normalizeOptionalString(model) ?? DEFAULT_KLING_IMAGE_MODEL;
  if (normalized === DEFAULT_KLING_IMAGE_MODEL || normalized === OMNI_KLING_IMAGE_MODEL) {
    return normalized;
  }
  throw new Error(
    `Unsupported KlingAI image model: ${normalized}. Supported models: ${SUPPORTED_IMAGE_MODELS.join(", ")}`,
  );
}

export function buildKlingaiImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "klingai",
    label: "KlingAI",
    defaultModel: DEFAULT_KLING_IMAGE_MODEL,
    models: [...SUPPORTED_IMAGE_MODELS],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "klingai",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxCount: 4,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: false,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: 1,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: false,
      },
      geometry: {
        aspectRatios: [...SUPPORTED_ASPECT_RATIOS],
        resolutions: ["1K", "2K", "4K"],
      },
    },
    async generateImage(req) {
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("KlingAI image generation supports at most one reference image.");
      }
      const auth = await resolveApiKeyForProvider({
        provider: "klingai",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("KlingAI API key missing");
      }
      const fetchFn = fetch;
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveKlingHttpConfig({
        apiKey: auth.apiKey,
        configuredBaseUrl: req.cfg?.models?.providers?.klingai?.baseUrl,
        capability: "image",
      });
      const model = resolveImageModel(req.model);
      const endpointPath = model === OMNI_KLING_IMAGE_MODEL ? OMNI_IMAGE_ENDPOINT : BASIC_IMAGE_ENDPOINT;
      const resolution = mapImageResolution(req.resolution);
      if (model === DEFAULT_KLING_IMAGE_MODEL && resolution === "4k") {
        throw new Error(
          "KlingAI image model kling-v3 does not support 4K. Use model kling-v3-omni for 4K image generation.",
        );
      }
      const body: Record<string, unknown> =
        model === OMNI_KLING_IMAGE_MODEL
          ? {
              model_name: model,
              prompt: req.prompt,
              resolution,
              aspect_ratio: normalizeOptionalString(req.aspectRatio) ?? "auto",
              result_type: "single",
              n: req.count ?? 1,
              callback_url: "",
            }
          : {
              model_name: model,
              prompt: req.prompt,
              negative_prompt: "",
              n: req.count ?? 1,
              aspect_ratio: normalizeOptionalString(req.aspectRatio) ?? DEFAULT_IMAGE_ASPECT_RATIO,
              resolution,
              callback_url: "",
            };
      const inputImage = req.inputImages?.[0];
      if (inputImage) {
        if (model === OMNI_KLING_IMAGE_MODEL) {
          body.image_list = [{ image: resolveImageReference(inputImage) }];
        } else {
          body.image = resolveImageReference(inputImage);
        }
      }

      const taskId = await submitKlingTask({
        endpointPath,
        body,
        headers,
        timeoutMs: req.timeoutMs,
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
        baseUrl,
        context: "KlingAI image generation",
      });
      const completed = await pollKlingTaskUntilComplete({
        queryPath: `${baseUrl}${endpointPath}`,
        taskId,
        headers,
        timeoutMs: req.timeoutMs,
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
        context: "KlingAI image generation",
      });
      const urls = listKlingImageUrls(completed);
      if (urls.length === 0) {
        throw new Error("KlingAI image generation completed without output image URLs");
      }
      const images: GeneratedImageAsset[] = [];
      for (const [index, url] of urls.entries()) {
        const downloaded = await downloadKlingBinaryAsset({
          url,
          timeoutMs: req.timeoutMs,
          fetchFn,
          allowPrivateNetwork,
          dispatcherPolicy,
          context: "KlingAI generated image",
        });
        images.push({
          buffer: downloaded.buffer,
          mimeType: downloaded.mimeType,
          fileName: `image-${index + 1}.${fileExtensionForMimeType(downloaded.mimeType)}`,
        });
      }
      return {
        images,
        model,
        metadata: {
          taskId,
          taskStatus: completed.task_status,
        },
      };
    },
  };
}
