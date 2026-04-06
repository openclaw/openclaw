import type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationRequest,
  ImageGenerationResult,
} from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  fetchWithTimeout,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";

const DEFAULT_PRODIA_BASE_URL = "https://inference.prodia.com";
const DEFAULT_PRODIA_IMAGE_MODEL = "flux-fast-schnell";
const DEFAULT_TIMEOUT_MS = 120_000;

// Prodia image model IDs mapped to /v2/job type strings.
const TEXT_TO_IMAGE_TYPES: Record<string, string> = {
  "flux-fast-schnell": "inference.flux-fast.schnell.txt2img.v2",
  "flux-dev": "inference.flux-2.dev.txt2img.v1",
  "flux-pro": "inference.flux-2.pro.txt2img.v1",
  "flux-max": "inference.flux-2.max.txt2img.v1",
  "flux-flex": "inference.flux-2.flex.txt2img.v1",
  "flux-klein": "inference.flux-2.klein.txt2img.v1",
  "flux-klein-4b": "inference.flux-2.klein.4b.txt2img.v1",
  "flux-klein-9b": "inference.flux-2.klein.9b.txt2img.v1",
  "recraft-v4": "inference.recraft.v4.txt2vec.v1",
};

const IMAGE_TO_IMAGE_TYPES: Record<string, string> = {
  "flux-dev": "inference.flux-2.dev.img2img.v1",
  "flux-pro": "inference.flux-2.pro.img2img.v1",
  "flux-max": "inference.flux-2.max.img2img.v1",
  "flux-flex": "inference.flux-2.flex.img2img.v1",
  "flux-klein": "inference.flux-2.klein.img2img.v1",
  "flux-klein-4b": "inference.flux-2.klein.4b.img2img.v1",
  "flux-klein-9b": "inference.flux-2.klein.9b.img2img.v1",
  "flux-ghibli": "inference.flux-control.dev.ghibli.img2img.v1",
  "flux-kontext": "inference.flux-fast.dev-kontext.img2img.v1",
};

const ALL_MODELS = [
  "flux-fast-schnell",
  "flux-dev",
  "flux-pro",
  "flux-max",
  "flux-flex",
  "flux-klein",
  "flux-klein-4b",
  "flux-klein-9b",
  "flux-ghibli",
  "flux-kontext",
  "recraft-v4",
];

type ProdiaJobPart = {
  id?: string;
  type?: string;
  state?: { current?: string };
  error?: string;
  config?: Record<string, unknown>;
};

function resolveJobType(model: string, hasImage: boolean): string {
  if (hasImage) {
    const type = IMAGE_TO_IMAGE_TYPES[model];
    if (!type) {
      throw new Error(
        `Prodia image editing does not support model "${model}". Use one of: ${Object.keys(IMAGE_TO_IMAGE_TYPES).join(", ")}.`,
      );
    }
    return type;
  }
  const type = TEXT_TO_IMAGE_TYPES[model];
  if (!type) {
    throw new Error(
      `Prodia text-to-image does not support model "${model}". Use one of: ${Object.keys(TEXT_TO_IMAGE_TYPES).join(", ")}.`,
    );
  }
  return type;
}

function buildJobConfig(req: ImageGenerationRequest): Record<string, unknown> {
  const config: Record<string, unknown> = {
    prompt: req.prompt,
  };
  if (req.size?.trim()) {
    const [w, h] = req.size.trim().split("x").map(Number);
    if (w && h) {
      config.width = w;
      config.height = h;
    }
  }
  return config;
}

function resolveBaseUrl(req: ImageGenerationRequest): string {
  return req.cfg?.models?.providers?.prodia?.baseUrl?.trim() || DEFAULT_PRODIA_BASE_URL;
}

/**
 * Prodia /v2/job returns either raw image bytes (when Accept specifies an image
 * format) or a multipart/form-data response with "job" and "output" parts.
 */
async function parseProdiaImageResponse(
  response: Response,
): Promise<{ job: ProdiaJobPart; imageBuffers: Array<{ buffer: Buffer; mimeType: string }> }> {
  const contentType = response.headers.get("content-type") ?? "";

  // Direct image response.
  if (contentType.startsWith("image/")) {
    const arrayBuffer = await response.arrayBuffer();
    return {
      job: { state: { current: "completed" } },
      imageBuffers: [{ buffer: Buffer.from(arrayBuffer), mimeType: contentType.split(";")[0] }],
    };
  }

  // Multipart response.
  const boundary = contentType.match(/boundary=([^\s;]+)/)?.[1];
  if (!boundary) {
    const text = await response.text();
    try {
      const job = JSON.parse(text) as ProdiaJobPart;
      return { job, imageBuffers: [] };
    } catch {
      throw new Error(`Prodia: unexpected response content-type "${contentType}"`);
    }
  }

  const arrayBuffer = await response.arrayBuffer();
  const raw = Buffer.from(arrayBuffer);
  const boundaryBytes = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let start = 0;

  while (true) {
    const idx = raw.indexOf(boundaryBytes, start);
    if (idx === -1) {
      break;
    }
    if (parts.length > 0) {
      parts.push(raw.subarray(start, idx));
    }
    start = idx + boundaryBytes.length;
    if (raw[start] === 0x2d && raw[start + 1] === 0x2d) {
      break;
    }
    if (raw[start] === 0x0d) {
      start += 1;
    }
    if (raw[start] === 0x0a) {
      start += 1;
    }
  }

  let job: ProdiaJobPart = {};
  const imageBuffers: Array<{ buffer: Buffer; mimeType: string }> = [];

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      continue;
    }
    const headerText = part.subarray(0, headerEnd).toString("utf-8");
    const body = part.subarray(headerEnd + 4);
    const trimmedBody =
      body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a
        ? body.subarray(0, body.length - 2)
        : body;

    if (headerText.includes('name="job"') || headerText.includes("application/json")) {
      try {
        job = JSON.parse(trimmedBody.toString("utf-8")) as ProdiaJobPart;
      } catch {
        // Ignore parse failures.
      }
    } else if (
      headerText.includes('name="output"') ||
      headerText.includes("image/") ||
      headerText.includes("application/octet-stream")
    ) {
      if (trimmedBody.length > 0) {
        const partMime = headerText.match(/Content-Type:\s*([^\s;\r\n]+)/i)?.[1] || "image/png";
        imageBuffers.push({ buffer: Buffer.from(trimmedBody), mimeType: partMime });
      }
    }
  }

  return { job, imageBuffers };
}

export function buildProdiaImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "prodia",
    label: "Prodia",
    defaultModel: DEFAULT_PRODIA_IMAGE_MODEL,
    models: ALL_MODELS,
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "prodia",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxCount: 1,
        supportsSize: true,
      },
      edit: {
        enabled: true,
        maxInputImages: 1,
        supportsSize: true,
      },
    },
    async generateImage(req): Promise<ImageGenerationResult> {
      const auth = await resolveApiKeyForProvider({
        provider: "prodia",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Prodia API key missing");
      }

      const hasImage = (req.inputImages?.length ?? 0) > 0;
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("Prodia image generation supports at most one input image.");
      }

      const model = req.model?.trim() || DEFAULT_PRODIA_IMAGE_MODEL;
      const jobType = resolveJobType(model, hasImage);
      const config = buildJobConfig(req);
      const baseUrl = resolveBaseUrl(req);
      const fetchFn = fetch;

      if (hasImage) {
        const image = req.inputImages![0];
        if (!image.buffer) {
          throw new Error("Prodia image editing requires a local image buffer.");
        }

        const jobPayload = JSON.stringify({ type: jobType, config });
        const formData = new FormData();
        formData.append("job", new Blob([jobPayload], { type: "application/json" }));
        formData.append(
          "input",
          new Blob([new Uint8Array(image.buffer)], { type: image.mimeType?.trim() || "image/png" }),
          image.fileName || "input.png",
        );

        const { baseUrl: resolvedBaseUrl, headers } = resolveProviderHttpRequestConfig({
          baseUrl,
          defaultBaseUrl: DEFAULT_PRODIA_BASE_URL,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            Accept: "multipart/form-data",
          },
          provider: "prodia",
          capability: "image",
          transport: "http",
        });
        headers.delete("Content-Type");

        const response = await fetchWithTimeout(
          `${resolvedBaseUrl}/v2/job`,
          { method: "POST", headers, body: formData },
          req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          fetchFn,
        );
        await assertOkOrThrowHttpError(response, "Prodia image generation failed");

        const { job, imageBuffers } = await parseProdiaImageResponse(response);
        if (job.state?.current === "failed" || job.error) {
          throw new Error(job.error?.trim() || "Prodia image generation failed");
        }
        if (imageBuffers.length === 0) {
          throw new Error("Prodia image generation completed without output");
        }

        return {
          images: imageBuffers.map<GeneratedImageAsset>((img, i) => ({
            buffer: img.buffer,
            mimeType: img.mimeType,
            fileName: `image-${i + 1}.${img.mimeType.includes("png") ? "png" : img.mimeType.includes("webp") ? "webp" : "jpg"}`,
            metadata: { jobId: job.id },
          })),
          model,
          metadata: { jobId: job.id, jobType, state: job.state?.current },
        };
      }

      // Text-to-image: JSON request.
      const { baseUrl: resolvedBaseUrl, headers } = resolveProviderHttpRequestConfig({
        baseUrl,
        defaultBaseUrl: DEFAULT_PRODIA_BASE_URL,
        defaultHeaders: {
          Authorization: `Bearer ${auth.apiKey}`,
          "Content-Type": "application/json",
          Accept: "multipart/form-data",
        },
        provider: "prodia",
        capability: "image",
        transport: "http",
      });

      const response = await fetchWithTimeout(
        `${resolvedBaseUrl}/v2/job`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ type: jobType, config }),
        },
        req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        fetchFn,
      );
      await assertOkOrThrowHttpError(response, "Prodia image generation failed");

      const { job, imageBuffers } = await parseProdiaImageResponse(response);
      if (job.state?.current === "failed" || job.error) {
        throw new Error(job.error?.trim() || "Prodia image generation failed");
      }
      if (imageBuffers.length === 0) {
        throw new Error("Prodia image generation completed without output");
      }

      return {
        images: imageBuffers.map<GeneratedImageAsset>((img, i) => ({
          buffer: img.buffer,
          mimeType: img.mimeType,
          fileName: `image-${i + 1}.${img.mimeType.includes("png") ? "png" : img.mimeType.includes("webp") ? "webp" : "jpg"}`,
          metadata: { jobId: job.id },
        })),
        model,
        metadata: { jobId: job.id, jobType, state: job.state?.current },
      };
    },
  };
}
