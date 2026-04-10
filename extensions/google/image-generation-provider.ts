import type { ImageGenerationProvider } from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeSecretInput } from "openclaw/plugin-sdk/secret-input";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  DEFAULT_GOOGLE_API_BASE_URL,
  normalizeGoogleApiBaseUrl,
  normalizeGoogleModelId,
  parseGeminiAuth,
} from "./api.js";

const DEFAULT_GOOGLE_IMAGE_MODEL = "gemini-3.1-flash-image-preview";
const DEFAULT_OUTPUT_MIME = "image/png";
const GOOGLE_SUPPORTED_SIZES = [
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "1024x1792",
  "1792x1024",
] as const;
const GOOGLE_SUPPORTED_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;

/**
 * Browser-safe environment variable reader.
 */
function readProviderEnvValue(envVars: string[]): string | undefined {
  const env = typeof process !== "undefined" ? process.env : undefined;
  if (!env) {
    return undefined;
  }
  for (const envVar of envVars) {
    const value = normalizeSecretInput(env[envVar]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

type GoogleInlineDataPart = {
  mimeType?: string;
  mime_type?: string;
  data?: string;
};

type GoogleGenerateImageResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: GoogleInlineDataPart;
        inline_data?: GoogleInlineDataPart;
      }>;
    };
  }>;
};

type OpenAICompatibleImageResponse = {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
  error?: {
    message?: string;
  };
};

function resolveGoogleBaseUrl(cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"]): string {
  const fromConfig = cfg?.models?.providers?.google?.baseUrl;
  const fromEnv = readProviderEnvValue([
    "GOOGLE_GEMINI_ENDPOINT",
    "GEMINI_BASE_URL",
    "GOOGLE_GEMINI_BASE_URL",
  ]);
  return normalizeGoogleApiBaseUrl(fromConfig || fromEnv);
}

function resolveGoogleApiType(
  cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
): "gemini" | "openai-compatible" {
  const googleConfig = cfg?.models?.providers?.google as Record<string, unknown> | undefined;
  const configuredApiType = googleConfig?.apiType;
  const envApiType = readProviderEnvValue(["GEMINI_API_TYPE"]);

  if (configuredApiType === "openai-compatible" || envApiType === "openai-compatible") {
    return "openai-compatible";
  }

  const baseUrl = resolveGoogleBaseUrl(cfg);
  if (
    !baseUrl.includes("googleapis.com") &&
    (baseUrl.endsWith("/v1") || baseUrl.includes("/v1/"))
  ) {
    return "openai-compatible";
  }

  return "gemini";
}

function normalizeGoogleImageModel(model: string | undefined): string {
  const trimmed = model?.trim();
  return normalizeGoogleModelId(trimmed || DEFAULT_GOOGLE_IMAGE_MODEL);
}

function mapSizeToImageConfig(
  size: string | undefined,
): { aspectRatio?: string; imageSize?: "2K" | "4K" } | undefined {
  const trimmed = size?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  const mapping = new Map<string, string>([
    ["1024x1024", "1:1"],
    ["1024x1536", "2:3"],
    ["1536x1024", "3:2"],
    ["1024x1792", "9:16"],
    ["1792x1024", "16:9"],
  ]);
  const aspectRatio = mapping.get(normalized);

  const [widthRaw, heightRaw] = normalized.split("x");
  const width = Number.parseInt(widthRaw ?? "", 10);
  const height = Number.parseInt(heightRaw ?? "", 10);
  const longestEdge = Math.max(width, height);
  const imageSize = longestEdge >= 3072 ? "4K" : longestEdge >= 1536 ? "2K" : undefined;

  if (!aspectRatio && !imageSize) {
    return undefined;
  }

  return {
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(imageSize ? { imageSize } : {}),
  };
}

export function buildGoogleImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "google",
    label: "Google",
    defaultModel: DEFAULT_GOOGLE_IMAGE_MODEL,
    models: [DEFAULT_GOOGLE_IMAGE_MODEL, "gemini-3-pro-image-preview"],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "google",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: 5,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      geometry: {
        sizes: [...GOOGLE_SUPPORTED_SIZES],
        aspectRatios: [...GOOGLE_SUPPORTED_ASPECT_RATIOS],
        resolutions: ["1K", "2K", "4K"],
      },
    },
    async generateImage(req) {
      const auth = await resolveApiKeyForProvider({
        provider: "google",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Google API key missing");
      }

      const model = normalizeGoogleImageModel(req.model);
      const apiType = resolveGoogleApiType(req.cfg);
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveGoogleBaseUrl(req.cfg),
          defaultBaseUrl: DEFAULT_GOOGLE_API_BASE_URL,
          allowPrivateNetwork: true, // Always allow for custom endpoints
          defaultHeaders: parseGeminiAuth(auth.apiKey).headers,
          provider: "google",
          api: "google-generative-ai",
          capability: "image",
          transport: "http",
        });

      if (apiType === "openai-compatible") {
        const endpoint = `${baseUrl.replace(/\/$/, "")}/images/generations`;
        // We omit response_format: "b64_json" because LiteLLM Proxy for Gemini doesn't support it.
        const requestHeaders = new Headers(headers);
        requestHeaders.set("Authorization", `Bearer ${auth.apiKey}`);

        const { response: res, release } = await postJsonRequest({
          url: endpoint,
          headers: requestHeaders,
          body: {
            model,
            prompt: req.prompt,
            n: req.count ?? 1,
            size: req.size ?? "1024x1024",
          },
          timeoutMs: 60_000,
          fetchFn: fetch,
          allowPrivateNetwork,
          dispatcherPolicy,
        });

        try {
          await assertOkOrThrowHttpError(res, "Google image generation failed (OpenAI-compatible)");
          const payload = (await res.json()) as OpenAICompatibleImageResponse;
          const images = await Promise.all(
            (payload.data ?? []).map(async (item, index) => {
              if (item.b64_json) {
                return {
                  buffer: Buffer.from(item.b64_json, "base64"),
                  mimeType: DEFAULT_OUTPUT_MIME,
                  fileName: `image-${index + 1}.png`,
                };
              } else if (item.url) {
                const imgRes = await fetch(item.url);
                if (!imgRes.ok) {
                  return null;
                }
                const buffer = Buffer.from(await imgRes.arrayBuffer());
                const mimeType = imgRes.headers.get("content-type") || DEFAULT_OUTPUT_MIME;
                const extension = mimeType.includes("jpeg")
                  ? "jpg"
                  : (mimeType.split("/")[1] ?? "png");
                return {
                  buffer,
                  mimeType,
                  fileName: `image-${index + 1}.${extension}`,
                };
              }
              return null;
            }),
          );

          const filteredImages = images.filter(
            (img): img is NonNullable<typeof img> => img !== null,
          );

          if (filteredImages.length === 0) {
            throw new Error("Google image generation response missing image data");
          }
          return { images: filteredImages, model };
        } finally {
          await release();
        }
      }

      const imageConfig = mapSizeToImageConfig(req.size);
      const inputParts = (req.inputImages ?? []).map((image) => ({
        inlineData: {
          mimeType: image.mimeType,
          data: image.buffer.toString("base64"),
        },
      }));
      const resolvedImageConfig = {
        ...imageConfig,
        ...(req.aspectRatio?.trim() ? { aspectRatio: req.aspectRatio.trim() } : {}),
        ...(req.resolution ? { imageSize: req.resolution } : {}),
      };

      const { response: res, release } = await postJsonRequest({
        url: `${baseUrl}/models/${model}:generateContent`,
        headers,
        body: {
          contents: [
            {
              role: "user",
              parts: [...inputParts, { text: req.prompt }],
            },
          ],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            ...(Object.keys(resolvedImageConfig).length > 0
              ? { imageConfig: resolvedImageConfig }
              : {}),
          },
        },
        timeoutMs: 60_000,
        fetchFn: fetch,
        pinDns: false,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(res, "Google image generation failed");

        const payload = (await res.json()) as GoogleGenerateImageResponse;
        let imageIndex = 0;
        const images = (payload.candidates ?? [])
          .flatMap((candidate) => candidate.content?.parts ?? [])
          .map((part) => {
            const inline = part.inlineData ?? part.inline_data;
            const data = inline?.data?.trim();
            if (!data) {
              return null;
            }
            const mimeType = inline?.mimeType ?? inline?.mime_type ?? DEFAULT_OUTPUT_MIME;
            const extension = mimeType.includes("jpeg") ? "jpg" : (mimeType.split("/")[1] ?? "png");
            imageIndex += 1;
            return {
              buffer: Buffer.from(data, "base64"),
              mimeType,
              fileName: `image-${imageIndex}.${extension}`,
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        if (images.length === 0) {
          throw new Error("Google image generation response missing image data");
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
