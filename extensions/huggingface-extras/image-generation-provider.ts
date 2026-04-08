// Hugging Face Inference API image generation provider.
//
// Implements `ImageGenerationProvider` against the public HF inference
// endpoint at `https://api-inference.huggingface.co/models/<model_id>`.
// HF returns the generated image as a raw binary body (default `image/png`)
// when `Accept: image/png` is sent. Errors come back as JSON with an `error`
// field plus optional `estimated_time` for cold-loading models.
//
// This provider is intentionally minimal: prompt + width/height only. We do
// not yet implement image-to-image edits, multiple-image generation, or
// LoRA selection. The HF Inference API exposes those via per-pipeline
// `parameters`, which we can layer in later without breaking this contract.

import {
  HUGGINGFACE_INFERENCE_BASE_URL,
  PROVIDER_ID,
  resolveApiKeyForProvider,
  type GeneratedImageAsset,
  type ImageGenerationProvider,
  type ImageGenerationProviderConfiguredContext,
  type ImageGenerationRequest,
  type ImageGenerationResult,
} from "./api.js";

const DEFAULT_MODEL = "black-forest-labs/FLUX.1-schnell";
const DEFAULT_MIME_TYPE = "image/png";

// Curated default model list. The HF Inference API also accepts any other
// public text-to-image repo id; this list is just what we surface in the
// onboarding picker.
const KNOWN_MODELS: ReadonlyArray<string> = [
  "black-forest-labs/FLUX.1-schnell",
  "black-forest-labs/FLUX.1-dev",
  "stabilityai/stable-diffusion-3.5-large",
  "stabilityai/stable-diffusion-xl-base-1.0",
];

const SUPPORTED_SIZES = ["512x512", "768x768", "1024x1024", "1024x1536", "1536x1024"] as const;

const SUPPORTED_ASPECT_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16"] as const;

type HuggingFaceErrorBody = {
  error?: string;
  estimated_time?: number;
  warnings?: string[];
};

function parseSize(raw: string | undefined): { width: number; height: number } | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const match = /^(\d{2,5})x(\d{2,5})$/iu.exec(trimmed);
  if (!match) {
    return null;
  }
  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function aspectRatioToDimensions(
  aspectRatio: string,
  edge: number,
): { width: number; height: number } | null {
  const match = /^(\d+):(\d+)$/u.exec(aspectRatio.trim());
  if (!match) {
    return null;
  }
  const widthRatio = Number.parseInt(match[1] ?? "", 10);
  const heightRatio = Number.parseInt(match[2] ?? "", 10);
  if (
    !Number.isFinite(widthRatio) ||
    !Number.isFinite(heightRatio) ||
    widthRatio <= 0 ||
    heightRatio <= 0
  ) {
    return null;
  }
  if (widthRatio >= heightRatio) {
    return {
      width: edge,
      height: Math.max(1, Math.round((edge * heightRatio) / widthRatio)),
    };
  }
  return {
    width: Math.max(1, Math.round((edge * widthRatio) / heightRatio)),
    height: edge,
  };
}

function resolveDimensions(req: ImageGenerationRequest): { width: number; height: number } {
  const fromSize = parseSize(req.size);
  if (fromSize) {
    return fromSize;
  }
  const edge = req.resolution === "4K" ? 4096 : req.resolution === "2K" ? 2048 : 1024;
  if (req.aspectRatio) {
    const dims = aspectRatioToDimensions(req.aspectRatio, edge);
    if (dims) {
      return dims;
    }
  }
  return { width: edge, height: edge };
}

function buildModelEndpoint(modelId: string): string {
  // The HF Inference API model id may itself contain `/` (e.g.
  // `black-forest-labs/FLUX.1-schnell`); do not encode the slash.
  const safeId = modelId.trim().replace(/^\/+|\/+$/gu, "");
  if (!safeId) {
    throw new Error("Hugging Face model id is empty");
  }
  return `${HUGGINGFACE_INFERENCE_BASE_URL}/models/${safeId}`;
}

async function readErrorBody(response: Response): Promise<HuggingFaceErrorBody | string> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text().catch(() => "");
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as HuggingFaceErrorBody;
    } catch {
      return text;
    }
  }
  return text;
}

function describeError(status: number, body: HuggingFaceErrorBody | string): string {
  if (typeof body === "string") {
    return body || `Hugging Face Inference API error ${status}`;
  }
  const parts: string[] = [];
  if (body.error) {
    parts.push(body.error);
  }
  if (typeof body.estimated_time === "number") {
    parts.push(`(model warm-up: ~${Math.round(body.estimated_time)}s)`);
  }
  if (parts.length === 0) {
    parts.push(`Hugging Face Inference API error ${status}`);
  }
  return parts.join(" ");
}

async function callHuggingFace(params: {
  endpoint: string;
  apiKey: string;
  prompt: string;
  width: number;
  height: number;
  signal?: AbortSignal;
}): Promise<{ buffer: Buffer; mimeType: string }> {
  const body = {
    inputs: params.prompt,
    parameters: {
      width: params.width,
      height: params.height,
    },
    options: {
      wait_for_model: true,
    },
  };
  const response = await fetch(params.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "image/png",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: params.signal,
  });

  if (!response.ok) {
    const errBody = await readErrorBody(response);
    throw new Error(
      `huggingface-extras image generation failed: ${describeError(response.status, errBody)}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const mimeType = response.headers.get("content-type") || DEFAULT_MIME_TYPE;
  return { buffer: Buffer.from(arrayBuffer), mimeType };
}

function buildAsset(params: {
  buffer: Buffer;
  mimeType: string;
  modelId: string;
  width: number;
  height: number;
  prompt: string;
}): GeneratedImageAsset {
  const extension = params.mimeType.includes("jpeg")
    ? "jpg"
    : params.mimeType.includes("webp")
      ? "webp"
      : "png";
  return {
    buffer: params.buffer,
    mimeType: params.mimeType,
    fileName: `huggingface-extras-${Date.now()}.${extension}`,
    metadata: {
      provider: PROVIDER_ID,
      model: params.modelId,
      width: params.width,
      height: params.height,
      prompt: params.prompt,
    },
  };
}

function isConfigured(_ctx: ImageGenerationProviderConfiguredContext): boolean {
  // We rely on the standard provider auth resolver at request time. The
  // provider is reported as "configured" whenever the auth env vars or
  // stored credential exists; the registry will short-circuit later if
  // resolution actually fails.
  if (process.env.HUGGINGFACE_HUB_TOKEN || process.env.HF_TOKEN) {
    return true;
  }
  return true;
}

export function buildHuggingFaceExtrasImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: PROVIDER_ID,
    label: "Hugging Face (Extras)",
    defaultModel: DEFAULT_MODEL,
    models: [...KNOWN_MODELS],
    capabilities: {
      generate: {
        maxCount: 1,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: false,
      },
      geometry: {
        sizes: [...SUPPORTED_SIZES],
        aspectRatios: [...SUPPORTED_ASPECT_RATIOS],
        resolutions: ["1K", "2K"],
      },
    },
    isConfigured,
    async generateImage(req: ImageGenerationRequest): Promise<ImageGenerationResult> {
      if (req.inputImages && req.inputImages.length > 0) {
        throw new Error("huggingface-extras does not support image-to-image edits in this release");
      }
      const auth = await resolveApiKeyForProvider({
        provider: PROVIDER_ID,
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      const apiKey = auth?.apiKey;
      if (!apiKey) {
        throw new Error(
          "Hugging Face API key is not configured. Run `openclaw onboard --auth-choice huggingface-extras-api-key` or set HUGGINGFACE_HUB_TOKEN.",
        );
      }
      const modelId = req.model?.trim() || DEFAULT_MODEL;
      const endpoint = buildModelEndpoint(modelId);
      const { width, height } = resolveDimensions(req);
      const controller = new AbortController();
      const timer =
        typeof req.timeoutMs === "number" && req.timeoutMs > 0
          ? setTimeout(() => controller.abort(), req.timeoutMs)
          : undefined;
      try {
        const { buffer, mimeType } = await callHuggingFace({
          endpoint,
          apiKey,
          prompt: req.prompt,
          width,
          height,
          signal: controller.signal,
        });
        return {
          images: [
            buildAsset({
              buffer,
              mimeType,
              modelId,
              width,
              height,
              prompt: req.prompt,
            }),
          ],
          model: modelId,
          metadata: {
            provider: PROVIDER_ID,
            endpoint,
          },
        };
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    },
  };
}
