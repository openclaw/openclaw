import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationSourceImage,
} from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  postMultipartRequest,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_IMAGE_MODELS,
  DEFAULT_DEEPINFRA_IMAGE_MODEL,
  DEFAULT_DEEPINFRA_IMAGE_SIZE,
  normalizeDeepInfraBaseUrl,
  normalizeDeepInfraModelRef,
} from "./media-models.js";

const DEEPINFRA_IMAGE_SIZES = ["512x512", "1024x1024", "1024x1792", "1792x1024"] as const;
const MAX_DEEPINFRA_INPUT_IMAGES = 1;

type DeepInfraProviderConfig = NonNullable<
  NonNullable<OpenClawConfig["models"]>["providers"]
>[string];

type DeepInfraImageApiResponse = {
  data?: Array<{
    b64_json?: string;
    revised_prompt?: string;
    url?: string;
  }>;
};

function resolveDeepInfraProviderConfig(
  cfg: OpenClawConfig | undefined,
): DeepInfraProviderConfig | undefined {
  return cfg?.models?.providers?.deepinfra;
}

function detectImageMimeType(buffer: Buffer): {
  mimeType: string;
  extension: "jpg" | "png" | "webp";
} {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return { mimeType: "image/jpeg", extension: "jpg" };
}

function imageToUploadName(image: ImageGenerationSourceImage, index: number): string {
  const fileName = normalizeOptionalString(image.fileName);
  if (fileName) {
    return fileName;
  }
  const mimeType = normalizeOptionalString(image.mimeType) ?? "image/png";
  const ext =
    mimeType === "image/jpeg" || mimeType === "image/jpg"
      ? "jpg"
      : mimeType === "image/webp"
        ? "webp"
        : "png";
  return `image-${index + 1}.${ext}`;
}

function imageToAsset(
  entry: NonNullable<DeepInfraImageApiResponse["data"]>[number],
  index: number,
): GeneratedImageAsset | null {
  const b64 = normalizeOptionalString(entry.b64_json);
  if (!b64) {
    return null;
  }
  const buffer = Buffer.from(b64, "base64");
  const detected = detectImageMimeType(buffer);
  const image: GeneratedImageAsset = {
    buffer,
    mimeType: detected.mimeType,
    fileName: `image-${index + 1}.${detected.extension}`,
  };
  const revisedPrompt = normalizeOptionalString(entry.revised_prompt);
  if (revisedPrompt) {
    image.revisedPrompt = revisedPrompt;
  }
  return image;
}

function parseImageResponse(payload: DeepInfraImageApiResponse): GeneratedImageAsset[] {
  return (payload.data ?? [])
    .map(imageToAsset)
    .filter((entry): entry is GeneratedImageAsset => entry !== null);
}

export function buildDeepInfraImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "deepinfra",
    label: "DeepInfra",
    defaultModel: DEFAULT_DEEPINFRA_IMAGE_MODEL,
    models: [...DEEPINFRA_IMAGE_MODELS],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "deepinfra",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: true,
        maxCount: 1,
        maxInputImages: MAX_DEEPINFRA_INPUT_IMAGES,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: {
        sizes: [...DEEPINFRA_IMAGE_SIZES],
      },
    },
    async generateImage(req) {
      const inputImages = req.inputImages ?? [];
      const isEdit = inputImages.length > 0;
      if (inputImages.length > MAX_DEEPINFRA_INPUT_IMAGES) {
        throw new Error("DeepInfra image editing supports one reference image.");
      }
      const auth = await resolveApiKeyForProvider({
        provider: "deepinfra",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("DeepInfra API key missing");
      }

      const providerConfig = resolveDeepInfraProviderConfig(req.cfg);
      const resolvedBaseUrl = normalizeDeepInfraBaseUrl(
        providerConfig?.baseUrl,
        DEEPINFRA_BASE_URL,
      );
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolvedBaseUrl,
          defaultBaseUrl: DEEPINFRA_BASE_URL,
          allowPrivateNetwork: false,
          request: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
          },
          provider: "deepinfra",
          capability: "image",
          transport: "http",
        });

      const model = normalizeDeepInfraModelRef(req.model, DEFAULT_DEEPINFRA_IMAGE_MODEL);
      const count = isEdit ? 1 : (req.count ?? 1);
      const size = normalizeOptionalString(req.size) ?? DEFAULT_DEEPINFRA_IMAGE_SIZE;
      const endpoint = isEdit ? "images/edits" : "images/generations";
      const request = isEdit
        ? (() => {
            const form = new FormData();
            form.set("model", model);
            form.set("prompt", req.prompt);
            form.set("n", String(count));
            form.set("size", size);
            form.set("response_format", "b64_json");
            const image = inputImages[0];
            if (!image) {
              throw new Error("DeepInfra image edit missing reference image.");
            }
            const mimeType = normalizeOptionalString(image.mimeType) ?? "image/png";
            form.append(
              "image",
              new Blob([new Uint8Array(image.buffer)], { type: mimeType }),
              imageToUploadName(image, 0),
            );
            const multipartHeaders = new Headers(headers);
            multipartHeaders.delete("Content-Type");
            return postMultipartRequest({
              url: `${baseUrl}/${endpoint}`,
              headers: multipartHeaders,
              body: form,
              timeoutMs: req.timeoutMs,
              fetchFn: fetch,
              allowPrivateNetwork,
              dispatcherPolicy,
            });
          })()
        : postJsonRequest({
            url: `${baseUrl}/${endpoint}`,
            headers: new Headers({
              ...Object.fromEntries(headers.entries()),
              "Content-Type": "application/json",
            }),
            body: {
              model,
              prompt: req.prompt,
              n: count,
              size,
              response_format: "b64_json",
            },
            timeoutMs: req.timeoutMs,
            fetchFn: fetch,
            allowPrivateNetwork,
            dispatcherPolicy,
          });

      const { response, release } = await request;
      try {
        await assertOkOrThrowHttpError(
          response,
          isEdit ? "DeepInfra image edit failed" : "DeepInfra image generation failed",
        );
        const images = parseImageResponse((await response.json()) as DeepInfraImageApiResponse);
        if (images.length === 0) {
          throw new Error("DeepInfra image response did not include generated image data");
        }
        return { images, model };
      } finally {
        await release();
      }
    },
  };
}
