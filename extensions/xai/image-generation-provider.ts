import type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationRequest,
} from "openclaw/plugin-sdk/image-generation";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth";
import { XAI_BASE_URL } from "./model-definitions.js";

const DEFAULT_XAI_IMAGE_MODEL = "grok-imagine-image";
const XAI_IMAGE_PROVIDER_ALIASES = ["xai-images"] as const;
const DEFAULT_OUTPUT_MIME = "image/jpeg";
const XAI_SUPPORTED_ASPECT_RATIOS = [
  "auto",
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
] as const;

type XaiImageDataEntry = {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
};

type XaiImageApiResponse = {
  data?: XaiImageDataEntry[];
  model?: string;
  respect_moderation?: boolean;
};

function resolveProviderBaseUrl(req: ImageGenerationRequest): string {
  const providerId = req.provider?.trim();
  const configured = providerId ? req.cfg?.models?.providers?.[providerId]?.baseUrl?.trim() : "";
  if (configured) {
    return configured.replace(/\/+$/u, "");
  }
  const fallback = req.cfg?.models?.providers?.xai?.baseUrl?.trim();
  return (fallback || XAI_BASE_URL).replace(/\/+$/u, "");
}

async function resolveProviderAuth(req: ImageGenerationRequest) {
  const providerId = req.provider?.trim() || "xai";
  try {
    return await resolveApiKeyForProvider({
      provider: providerId,
      cfg: req.cfg,
      agentDir: req.agentDir,
      store: req.authStore,
    });
  } catch (error) {
    if ((XAI_IMAGE_PROVIDER_ALIASES as readonly string[]).includes(providerId)) {
      return await resolveApiKeyForProvider({
        provider: "xai",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
    }
    throw error;
  }
}

function toDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function normalizeResolution(
  resolution: ImageGenerationRequest["resolution"],
): "1k" | "2k" | undefined {
  if (!resolution) {
    return undefined;
  }
  if (resolution === "1K") {
    return "1k";
  }
  if (resolution === "2K") {
    return "2k";
  }
  return undefined;
}

function buildImageBody(req: ImageGenerationRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model || DEFAULT_XAI_IMAGE_MODEL,
    prompt: req.prompt,
    n: req.count ?? 1,
    response_format: "b64_json",
  };

  if (req.aspectRatio?.trim()) {
    body.aspect_ratio = req.aspectRatio.trim();
  }
  const resolution = normalizeResolution(req.resolution);
  if (resolution) {
    body.resolution = resolution;
  }

  const inputImages = req.inputImages ?? [];
  if (inputImages.length === 1) {
    body.image = {
      type: "image_url",
      url: toDataUrl(inputImages[0].buffer, inputImages[0].mimeType),
    };
  } else if (inputImages.length > 1) {
    body.images = inputImages.map((image) => ({
      type: "image_url",
      url: toDataUrl(image.buffer, image.mimeType),
    }));
  }

  return body;
}

function fileExtensionForMimeType(mimeType: string): string {
  if (mimeType.includes("jpeg")) {
    return "jpg";
  }
  return mimeType.split("/")[1] ?? "jpg";
}

async function fetchImageBuffer(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `xAI image download failed (${response.status}): ${text || response.statusText}`,
    );
  }
  const mimeType = response.headers.get("content-type")?.trim() || DEFAULT_OUTPUT_MIME;
  const arrayBuffer = await response.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType };
}

async function resolveGeneratedAssets(
  entries: XaiImageDataEntry[],
): Promise<GeneratedImageAsset[]> {
  const images: Array<GeneratedImageAsset | null> = await Promise.all(
    entries.map(async (entry, index): Promise<GeneratedImageAsset | null> => {
      const b64 = entry.b64_json?.trim();
      if (b64) {
        return {
          buffer: Buffer.from(b64, "base64"),
          mimeType: DEFAULT_OUTPUT_MIME,
          fileName: `image-${index + 1}.jpg`,
          ...(entry.revised_prompt ? { revisedPrompt: entry.revised_prompt } : {}),
        };
      }
      const url = entry.url?.trim();
      if (!url) {
        return null;
      }
      const downloaded = await fetchImageBuffer(url);
      return {
        buffer: downloaded.buffer,
        mimeType: downloaded.mimeType,
        fileName: `image-${index + 1}.${fileExtensionForMimeType(downloaded.mimeType)}`,
        ...(entry.revised_prompt ? { revisedPrompt: entry.revised_prompt } : {}),
      };
    }),
  );
  return images.filter((entry): entry is GeneratedImageAsset => entry !== null);
}

export function buildXaiImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "xai",
    aliases: [...XAI_IMAGE_PROVIDER_ALIASES],
    label: "xAI",
    defaultModel: DEFAULT_XAI_IMAGE_MODEL,
    models: [DEFAULT_XAI_IMAGE_MODEL, "grok-imagine-image-pro"],
    capabilities: {
      generate: {
        maxCount: 10,
        supportsSize: false,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: true,
        maxCount: 10,
        maxInputImages: 5,
        supportsSize: false,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      geometry: {
        aspectRatios: [...XAI_SUPPORTED_ASPECT_RATIOS],
        resolutions: ["1K", "2K"],
      },
    },
    async generateImage(req) {
      const auth = await resolveProviderAuth(req);
      if (!auth.apiKey) {
        throw new Error("xAI API key missing");
      }

      const hasInputImages = (req.inputImages?.length ?? 0) > 0;
      const endpoint = hasInputImages ? "images/edits" : "images/generations";
      const response = await fetch(`${resolveProviderBaseUrl(req)}/${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildImageBody(req)),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `xAI image generation failed (${response.status}): ${text || response.statusText}`,
        );
      }

      const payload = (await response.json()) as XaiImageApiResponse;
      const images = await resolveGeneratedAssets(payload.data ?? []);
      if (images.length === 0) {
        throw new Error("xAI image generation response missing image data");
      }

      return {
        images,
        model: payload.model ?? req.model ?? DEFAULT_XAI_IMAGE_MODEL,
        metadata:
          payload.respect_moderation === undefined
            ? undefined
            : { respectModeration: payload.respect_moderation },
      };
    },
  };
}
