import type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationResolution,
} from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { OPENROUTER_BASE_URL, resolveConfiguredBaseUrl } from "./openrouter-config.js";
const DEFAULT_OPENROUTER_IMAGE_MODEL = "google/gemini-2.5-flash-image";
const OPENROUTER_IMAGE_MODELS = [
  "google/gemini-2.5-flash-image",
  "google/gemini-3.1-flash-image-preview",
  "black-forest-labs/flux.2-pro",
] as const;
// Dual-output models support both image and text in the same response.
// Default to image-only since that is universally supported; only known
// dual-output model families opt into ["image", "text"].
const DUAL_OUTPUT_MODEL_PREFIXES = ["google/", "openai/"] as const;

function resolveImageModalities(model: string): string[] {
  if (DUAL_OUTPUT_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix))) {
    return ["image", "text"];
  }
  return ["image"];
}

const OPENROUTER_IMAGE_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "9:16",
  "16:9",
] as const;
const OPENROUTER_IMAGE_RESOLUTIONS: readonly ImageGenerationResolution[] = ["1K", "2K", "4K"];

type OpenRouterImageMessage = {
  role: string;
  content?: string;
  images?: Array<{
    type?: string;
    image_url?: {
      url?: string;
    };
  }>;
};

type OpenRouterImageApiResponse = {
  choices?: Array<{
    message?: OpenRouterImageMessage;
  }>;
};

function extractBase64FromDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/u.exec(dataUrl);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    buffer: Buffer.from(match[2], "base64"),
    mimeType: match[1],
  };
}

function resolveFileExtension(mimeType: string): string {
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  return "png";
}

export function buildOpenrouterImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "openrouter",
    label: "OpenRouter",
    defaultModel: DEFAULT_OPENROUTER_IMAGE_MODEL,
    models: [...OPENROUTER_IMAGE_MODELS],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "openrouter",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxCount: 1,
        supportsSize: false,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: false,
      },
      geometry: {
        aspectRatios: [...OPENROUTER_IMAGE_ASPECT_RATIOS],
        resolutions: [...OPENROUTER_IMAGE_RESOLUTIONS],
      },
    },
    async generateImage(req) {
      if ((req.inputImages?.length ?? 0) > 0) {
        throw new Error("OpenRouter image generation does not support image editing");
      }

      const auth = await resolveApiKeyForProvider({
        provider: "openrouter",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("OpenRouter API key missing");
      }

      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveConfiguredBaseUrl(req.cfg),
          defaultBaseUrl: OPENROUTER_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
          },
          provider: "openrouter",
          capability: "image",
          transport: "http",
        });

      const model = normalizeOptionalString(req.model) ?? DEFAULT_OPENROUTER_IMAGE_MODEL;
      const aspectRatio = normalizeOptionalString(req.aspectRatio);
      const resolution = normalizeOptionalString(req.resolution);

      const imageConfig: Record<string, string> = {};
      if (aspectRatio) {
        imageConfig.aspect_ratio = aspectRatio;
      }
      if (resolution) {
        imageConfig.image_size = resolution;
      }

      const jsonHeaders = new Headers(headers);
      jsonHeaders.set("Content-Type", "application/json");
      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/chat/completions`,
        headers: jsonHeaders,
        body: {
          model,
          messages: [{ role: "user", content: req.prompt }],
          modalities: resolveImageModalities(model),
          ...(Object.keys(imageConfig).length > 0 ? { image_config: imageConfig } : {}),
        },
        timeoutMs: req.timeoutMs,
        fetchFn: fetch,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(response, "OpenRouter image generation failed");
        const data = (await response.json()) as OpenRouterImageApiResponse;
        const rawImages = data.choices?.[0]?.message?.images ?? [];

        const images: GeneratedImageAsset[] = rawImages
          .map((entry, index) => {
            const url = normalizeOptionalString(entry.image_url?.url);
            if (!url) {
              return null;
            }
            const parsed = extractBase64FromDataUrl(url);
            if (!parsed) {
              return null;
            }
            return {
              buffer: parsed.buffer,
              mimeType: parsed.mimeType,
              fileName: `image-${index + 1}.${resolveFileExtension(parsed.mimeType)}`,
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        if (images.length === 0) {
          throw new Error("OpenRouter image generation response missing image data");
        }

        return {
          images,
          model,
        };
      } finally {
        await release();
      }
    },
  };
}
