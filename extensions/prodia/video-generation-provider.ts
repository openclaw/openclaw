import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  fetchWithTimeout,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import type {
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationResult,
} from "openclaw/plugin-sdk/video-generation";

const DEFAULT_PRODIA_BASE_URL = "https://inference.prodia.com";
const DEFAULT_PRODIA_VIDEO_MODEL = "veo-fast";
const DEFAULT_TIMEOUT_MS = 300_000;

// Prodia video model IDs mapped to the /v2/job type strings.
const TEXT_TO_VIDEO_TYPES: Record<string, string> = {
  "veo-fast": "inference.veo.fast.txt2vid.v1",
  "wan2.2-lightning": "inference.wan2-2.lightning.txt2vid.v0",
};

const IMAGE_TO_VIDEO_TYPES: Record<string, string> = {
  "veo-fast": "inference.veo.fast.img2vid.v1",
  "wan2.2-lightning": "inference.wan2-2.lightning.img2vid.v0",
  "seedance-lite": "inference.seedance.lite.img2vid.v1",
  "seedance-pro": "inference.seedance.pro.img2vid.v1",
};

const ALL_MODELS = ["veo-fast", "wan2.2-lightning", "seedance-lite", "seedance-pro"];

type ProdiaJobPart = {
  id?: string;
  type?: string;
  state?: { current?: string };
  error?: string;
  config?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
};

function resolveJobType(model: string, hasImage: boolean): string {
  if (hasImage) {
    const type = IMAGE_TO_VIDEO_TYPES[model];
    if (!type) {
      throw new Error(
        `Prodia image-to-video does not support model "${model}". Use one of: ${Object.keys(IMAGE_TO_VIDEO_TYPES).join(", ")}.`,
      );
    }
    return type;
  }
  const type = TEXT_TO_VIDEO_TYPES[model];
  if (!type) {
    throw new Error(
      `Prodia text-to-video does not support model "${model}". Use one of: ${Object.keys(TEXT_TO_VIDEO_TYPES).join(", ")}.`,
    );
  }
  return type;
}

function resolveResolution(req: VideoGenerationRequest): string | undefined {
  if (req.resolution) {
    switch (req.resolution) {
      case "480P":
        return "480p";
      case "720P":
        return "720p";
      case "1080P":
        return "1080p";
      default:
        return undefined;
    }
  }
  return undefined;
}

function buildJobConfig(req: VideoGenerationRequest): Record<string, unknown> {
  const config: Record<string, unknown> = {
    prompt: req.prompt,
  };
  const resolution = resolveResolution(req);
  if (resolution) {
    config.resolution = resolution;
  }
  return config;
}

function resolveBaseUrl(req: VideoGenerationRequest): string {
  return req.cfg?.models?.providers?.prodia?.baseUrl?.trim() || DEFAULT_PRODIA_BASE_URL;
}

/**
 * Prodia /v2/job returns a multipart/form-data response containing:
 * - A "job" part with JSON metadata
 * - One or more "output" parts with the generated media
 *
 * When the Accept header requests a specific media type (e.g. video/mp4),
 * the response is the raw media bytes directly.
 */
async function parseMultipartJobResponse(
  response: Response,
): Promise<{ job: ProdiaJobPart; videoBuffers: Buffer[] }> {
  const contentType = response.headers.get("content-type") ?? "";

  // When we request video/mp4 via Accept, Prodia may return raw bytes.
  if (contentType.startsWith("video/")) {
    const arrayBuffer = await response.arrayBuffer();
    return {
      job: { state: { current: "completed" } },
      videoBuffers: [Buffer.from(arrayBuffer)],
    };
  }

  // multipart/form-data response: parse boundary parts.
  const boundary = contentType.match(/boundary=([^\s;]+)/)?.[1];
  if (!boundary) {
    // Fallback: treat the entire body as JSON job metadata with no output.
    const text = await response.text();
    try {
      const job = JSON.parse(text) as ProdiaJobPart;
      return { job, videoBuffers: [] };
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
      // Capture from previous boundary end to this boundary start.
      parts.push(raw.subarray(start, idx));
    }
    start = idx + boundaryBytes.length;
    // Skip past CRLF or -- (end marker).
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
  const videoBuffers: Buffer[] = [];

  for (const part of parts) {
    // Each part has headers separated from body by \r\n\r\n.
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      continue;
    }
    const headerText = part.subarray(0, headerEnd).toString("utf-8");
    const body = part.subarray(headerEnd + 4);
    // Trim trailing \r\n from body.
    const trimmedBody =
      body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a
        ? body.subarray(0, body.length - 2)
        : body;

    if (headerText.includes('name="job"') || headerText.includes("application/json")) {
      try {
        job = JSON.parse(trimmedBody.toString("utf-8")) as ProdiaJobPart;
      } catch {
        // Ignore parse failures for metadata.
      }
    } else if (
      headerText.includes('name="output"') ||
      headerText.includes("video/") ||
      headerText.includes("application/octet-stream")
    ) {
      if (trimmedBody.length > 0) {
        videoBuffers.push(Buffer.from(trimmedBody));
      }
    }
  }

  return { job, videoBuffers };
}

export function buildProdiaVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "prodia",
    label: "Prodia",
    defaultModel: DEFAULT_PRODIA_VIDEO_MODEL,
    models: ALL_MODELS,
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "prodia",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxVideos: 1,
        supportsResolution: true,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 1,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    async generateVideo(req): Promise<VideoGenerationResult> {
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
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("Prodia video generation does not support video reference inputs.");
      }
      if ((req.inputImages?.length ?? 0) > 1) {
        throw new Error("Prodia video generation supports at most one image reference.");
      }

      const model = req.model?.trim() || DEFAULT_PRODIA_VIDEO_MODEL;
      const jobType = resolveJobType(model, hasImage);
      const config = buildJobConfig(req);

      const baseUrl = resolveBaseUrl(req);
      const fetchFn = fetch;

      // For image-to-video, we use multipart/form-data to upload the image.
      // For text-to-video, we use application/json.
      if (hasImage) {
        const image = req.inputImages![0];
        const imageBuffer = image.buffer;
        const imageUrl = image.url?.trim();

        if (!imageBuffer && !imageUrl) {
          throw new Error("Prodia image-to-video input is missing image data.");
        }

        const jobPayload = JSON.stringify({ type: jobType, config });
        const formData = new FormData();
        formData.append("job", new Blob([jobPayload], { type: "application/json" }));

        if (imageBuffer) {
          const mimeType = image.mimeType?.trim() || "image/png";
          formData.append(
            "input",
            new Blob([new Uint8Array(imageBuffer)], { type: mimeType }),
            image.fileName || "input.png",
          );
        }

        const { baseUrl: resolvedBaseUrl, headers } = resolveProviderHttpRequestConfig({
          baseUrl,
          defaultBaseUrl: DEFAULT_PRODIA_BASE_URL,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            Accept: "multipart/form-data",
          },
          provider: "prodia",
          capability: "video",
          transport: "http",
        });

        // FormData sets its own Content-Type with boundary; remove any preset.
        headers.delete("Content-Type");

        const response = await fetchWithTimeout(
          `${resolvedBaseUrl}/v2/job`,
          {
            method: "POST",
            headers,
            body: formData,
          },
          req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          fetchFn,
        );
        await assertOkOrThrowHttpError(response, "Prodia video generation failed");

        const { job, videoBuffers } = await parseMultipartJobResponse(response);

        if (job.state?.current === "failed" || job.error) {
          throw new Error(job.error?.trim() || "Prodia video generation failed");
        }
        if (videoBuffers.length === 0) {
          throw new Error("Prodia video generation completed without output");
        }

        return {
          videos: videoBuffers.map((buffer, i) => ({
            buffer,
            mimeType: "video/mp4",
            fileName: `video-${i + 1}.mp4`,
            metadata: { jobId: job.id },
          })),
          model,
          metadata: {
            jobId: job.id,
            jobType,
            state: job.state?.current,
          },
        };
      }

      // Text-to-video: JSON request.
      const { baseUrl: resolvedBaseUrl, headers } = resolveProviderHttpRequestConfig({
        baseUrl,
        defaultBaseUrl: DEFAULT_PRODIA_BASE_URL,
        defaultHeaders: {
          Authorization: `Bearer ${auth.apiKey}`,
          "Content-Type": "application/json",
          Accept: "multipart/form-data",
        },
        provider: "prodia",
        capability: "video",
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
      await assertOkOrThrowHttpError(response, "Prodia video generation failed");

      const { job, videoBuffers } = await parseMultipartJobResponse(response);

      if (job.state?.current === "failed" || job.error) {
        throw new Error(job.error?.trim() || "Prodia video generation failed");
      }
      if (videoBuffers.length === 0) {
        throw new Error("Prodia video generation completed without output");
      }

      return {
        videos: videoBuffers.map((buffer, i) => ({
          buffer,
          mimeType: "video/mp4",
          fileName: `video-${i + 1}.mp4`,
          metadata: { jobId: job.id },
        })),
        model,
        metadata: {
          jobId: job.id,
          jobType,
          state: job.state?.current,
        },
      };
    },
  };
}
