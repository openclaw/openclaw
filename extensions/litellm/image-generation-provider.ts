import { isIP } from "node:net";
import { bufferToBlobPart } from "openclaw/plugin-sdk/blob-runtime";
import {
  createOpenAiCompatibleImageGenerationProvider,
  imageSourceUploadFileName,
  type ImageGenerationProvider,
} from "openclaw/plugin-sdk/image-generation";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { LITELLM_BASE_URL } from "./onboard.js";

const DEFAULT_SIZE = "1024x1024";
const DEFAULT_LITELLM_IMAGE_MODEL = "gpt-image-2";
const LITELLM_SUPPORTED_SIZES = [
  "256x256",
  "512x512",
  "1024x1024",
  "1024x1536",
  "1024x1792",
  "1536x1024",
  "1792x1024",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;
const LITELLM_MAX_INPUT_IMAGES = 5;

// LiteLLM's default proxy is loopback. Auto-enable private-network access only
// for loopback-style hosts; LAN/custom private endpoints should use the
// explicit models.providers.litellm.request.allowPrivateNetwork opt-in.
function shouldAutoAllowPrivateLitellmEndpoint(baseUrl: string): boolean {
  try {
    const { protocol, hostname } = new URL(baseUrl);
    if (protocol !== "http:" && protocol !== "https:") {
      return false;
    }
    return (
      hostname === "localhost" ||
      hostname === "host.docker.internal" ||
      hostname.endsWith(".localhost") ||
      hostname === "[::1]" ||
      (isIP(hostname) === 4 && hostname.startsWith("127."))
    );
  } catch {
    return false;
  }
}

export function buildLitellmImageGenerationProvider(): ImageGenerationProvider {
  return createOpenAiCompatibleImageGenerationProvider({
    id: "litellm",
    label: "LiteLLM",
    defaultModel: DEFAULT_LITELLM_IMAGE_MODEL,
    models: [DEFAULT_LITELLM_IMAGE_MODEL],
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: LITELLM_MAX_INPUT_IMAGES,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: {
        sizes: [...LITELLM_SUPPORTED_SIZES],
      },
    },
    defaultBaseUrl: LITELLM_BASE_URL,
    resolveAllowPrivateNetwork: ({ baseUrl }) =>
      shouldAutoAllowPrivateLitellmEndpoint(baseUrl) ? true : undefined,
    useConfiguredRequest: true,
    buildGenerateRequest: ({ req, model, count }) => ({
      kind: "json",
      body: {
        model,
        prompt: req.prompt,
        n: count,
        size: req.size ?? DEFAULT_SIZE,
      },
    }),
    // LiteLLM's /v1/images/edits is multipart (OpenAI's edits schema): the
    // reference image must be an uploaded file part, not a JSON field — a JSON
    // body fails before the request reaches the provider.
    buildEditRequest: ({ req, inputImages, model, count }) => {
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", req.prompt);
      form.set("n", String(count));
      form.set("size", req.size ?? DEFAULT_SIZE);
      // OpenAI-compatible edits take repeated `image[]` parts when more than one
      // reference is supplied, and a single `image` part otherwise.
      const partName = inputImages.length > 1 ? "image[]" : "image";
      for (const [index, image] of inputImages.entries()) {
        const mimeType = normalizeOptionalString(image.mimeType) ?? "image/png";
        form.append(
          partName,
          new Blob([bufferToBlobPart(image.buffer)], { type: mimeType }),
          imageSourceUploadFileName({ image, index }),
        );
      }
      return { kind: "multipart", form };
    },
    missingApiKeyError: "LiteLLM API key missing",
    failureLabels: {
      generate: "LiteLLM image generation failed",
      edit: "LiteLLM image edit failed",
    },
  });
}
