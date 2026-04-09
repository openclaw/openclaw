// Hugging Face video generation provider (P4).
//
// Routes through the HF Inference Providers router using the Replicate
// backend, which is the only HF-Pro-credit-eligible video provider that
// covers the popular Wan family.
//
// Why not also fal-ai/wavespeed:
// - fal-ai is paywalled outside HF Pro $2 monthly credits
// - wavespeed has a different async path shape, doubles complexity for
//   one extra HunyuanVideo-1.5 route. We can add it later if needed.
//
// Mapping resolution:
// - Default model list is bundled (BUNDLED_VIDEO_MAPPING) and covers the
//   four Wan models the user can actually run today.
// - For unknown model ids we hit `https://huggingface.co/api/models/{id}
//   ?expand[]=inferenceProviderMapping` at request time, cache the answer
//   in-memory, and pick the first replicate `live` route. If no replicate
//   route exists we throw with a helpful warning that includes the model
//   ids we ARE able to serve.
//
// Replicate's prediction API is async: POST returns `{id, status:"starting",
// urls.get}`, then we poll `urls.get` until status is `succeeded` and
// `output` is a video URL we download as bytes.

import {
  HUGGINGFACE_INFERENCE_BASE_URL,
  PROVIDER_ID,
  resolveApiKeyForProvider,
  type GeneratedVideoAsset,
  type VideoGenerationProvider,
  type VideoGenerationRequest,
  type VideoGenerationResult,
} from "./api.js";

const HF_HUB_API_BASE_URL = "https://huggingface.co/api";
const HF_REPLICATE_BASE_URL = HUGGINGFACE_INFERENCE_BASE_URL.replace("/hf-inference", "/replicate");

const DEFAULT_VIDEO_MODEL = "Wan-AI/Wan2.1-T2V-14B";

// Bundled fallback mapping. Source: HF model api expand=inferenceProviderMapping,
// captured 2026-04. Refreshed at runtime by `resolveReplicateProviderId`.
//
// Only models with a live replicate route are listed here. Models that only
// route through fal-ai (HunyuanVideo, mochi-1-preview, CogVideoX-5b,
// LongCat-Video, LTX-Video) intentionally do NOT appear so the warning path
// fires for them.
const BUNDLED_VIDEO_MAPPING: Readonly<Record<string, string>> = {
  "wan-ai/wan2.1-t2v-14b": "wavespeedai/wan-2.1-t2v-480p",
  "wan-ai/wan2.1-t2v-1.3b": "wavespeedai/wan-2.1-t2v-1.3b",
  "wan-ai/wan2.2-t2v-a14b": "wavespeedai/wan-2.2-t2v-a14b",
  "wan-ai/wan2.2-ti2v-5b": "wavespeedai/wan-2.2-ti2v-5b",
};

const KNOWN_VIDEO_MODELS: ReadonlyArray<string> = [
  "Wan-AI/Wan2.1-T2V-14B",
  "Wan-AI/Wan2.2-T2V-A14B",
  "Wan-AI/Wan2.2-TI2V-5B",
  "Wan-AI/Wan2.1-T2V-1.3B",
];

type HfMappingEntry = {
  status?: string;
  providerId?: string;
  task?: string;
};
type HfMappingResponse = {
  inferenceProviderMapping?: Record<string, HfMappingEntry> | HfMappingEntry[];
};

// Module-level memoization. Cleared on process restart, which is fine for
// long-running gateways and matches how the upstream JS SDK caches.
const mappingCache = new Map<string, string | null>();

function isFalAiOnlyModelMessage(modelId: string, providers: string[]): string {
  return [
    `huggingface-extras video: model "${modelId}" is not available on a HF Pro free route.`,
    `Provider mapping: ${providers.join(", ") || "(none)"}.`,
    `Only models with a live "replicate" route can be served. Known-good models for this provider:`,
    `  ${KNOWN_VIDEO_MODELS.join(", ")}`,
    `If you need fal-ai-only models (HunyuanVideo, Mochi, CogVideoX, etc.) you must add pre-paid fal-ai credits.`,
  ].join("\n");
}

async function resolveReplicateProviderId(modelId: string, hfToken: string): Promise<string> {
  const cacheKey = modelId.toLowerCase();
  const cached = mappingCache.get(cacheKey);
  if (cached === null) {
    throw new Error(isFalAiOnlyModelMessage(modelId, ["(cached: no replicate route)"]));
  }
  if (typeof cached === "string") {
    return cached;
  }

  // Bundled fallback first to avoid the network round-trip for the common
  // case where the user picks one of our recommended Wan models.
  const bundled = BUNDLED_VIDEO_MAPPING[cacheKey];
  if (bundled) {
    mappingCache.set(cacheKey, bundled);
    return bundled;
  }

  // Hit the HF Hub mapping endpoint. We swallow network errors and fall
  // through to a "no replicate route" warning rather than a stack trace,
  // because that is what the user actually needs to read.
  let mappingBody: HfMappingResponse | undefined;
  try {
    const url = `${HF_HUB_API_BASE_URL}/models/${encodeURI(modelId)}?expand[]=inferenceProviderMapping`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${hfToken}`,
      },
    });
    if (response.ok) {
      mappingBody = (await response.json()) as HfMappingResponse;
    }
  } catch {
    // ignore: we'll fall through to the not-supported warning
  }

  const rawMapping = mappingBody?.inferenceProviderMapping;
  const entries: Array<HfMappingEntry & { provider?: string }> = Array.isArray(rawMapping)
    ? rawMapping
    : rawMapping
      ? Object.entries(rawMapping).map(([provider, info]) => ({ ...info, provider }))
      : [];

  const liveProviders: string[] = [];
  let replicateProviderId: string | undefined;
  for (const entry of entries) {
    const provider = entry.provider;
    if (!provider) {
      continue;
    }
    liveProviders.push(provider);
    if (provider === "replicate" && entry.status === "live" && entry.providerId) {
      replicateProviderId = entry.providerId;
      break;
    }
  }

  if (!replicateProviderId) {
    mappingCache.set(cacheKey, null);
    throw new Error(isFalAiOnlyModelMessage(modelId, liveProviders));
  }
  mappingCache.set(cacheKey, replicateProviderId);
  return replicateProviderId;
}

type ReplicatePrediction = {
  id?: string;
  status?: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: string | string[] | null;
  error?: string | null;
  urls?: { get?: string };
};

async function postReplicatePrediction(params: {
  apiKey: string;
  providerModelId: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<ReplicatePrediction> {
  const url = `${HF_REPLICATE_BASE_URL}/v1/models/${params.providerModelId}/predictions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      input: { prompt: params.prompt },
    }),
    signal: params.signal,
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(
      `huggingface-extras video: replicate POST failed (${response.status}): ${text || "unknown error"}`,
    );
  }
  return JSON.parse(text) as ReplicatePrediction;
}

async function pollReplicatePrediction(params: {
  apiKey: string;
  predictionId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ReplicatePrediction> {
  const deadline = Date.now() + params.timeoutMs;
  // Replicate suggests ~1s polling for short tasks, longer for video. We use
  // 3s — fast enough that the first frame appears before the user gives up,
  // slow enough that we don't get throttled on a 60-90s prediction.
  const intervalMs = 3_000;
  const url = `${HF_REPLICATE_BASE_URL}/v1/predictions/${params.predictionId}`;

  while (Date.now() < deadline) {
    if (params.signal?.aborted) {
      throw new Error("huggingface-extras video: request aborted");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      signal: params.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `huggingface-extras video: replicate GET failed (${response.status}): ${text || "unknown"}`,
      );
    }
    const body = (await response.json()) as ReplicatePrediction;
    if (body.status === "succeeded") {
      return body;
    }
    if (body.status === "failed" || body.status === "canceled") {
      throw new Error(
        `huggingface-extras video: replicate prediction ${body.status}: ${body.error ?? "no error message"}`,
      );
    }
  }
  throw new Error(
    `huggingface-extras video: replicate prediction did not finish within ${params.timeoutMs}ms`,
  );
}

async function fetchVideoBytes(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(
      `huggingface-extras video: failed to download generated video (${response.status})`,
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  const mimeType = response.headers.get("content-type") || "video/mp4";
  return { buffer: Buffer.from(arrayBuffer), mimeType };
}

function pickOutputUrl(prediction: ReplicatePrediction): string {
  const out = prediction.output;
  if (typeof out === "string") {
    return out;
  }
  if (Array.isArray(out) && typeof out[0] === "string") {
    return out[0];
  }
  throw new Error("huggingface-extras video: replicate succeeded but no output URL was returned");
}

function buildVideoAsset(params: {
  buffer: Buffer;
  mimeType: string;
  modelId: string;
  prompt: string;
}): GeneratedVideoAsset {
  const ext = params.mimeType.includes("webm") ? "webm" : "mp4";
  return {
    buffer: params.buffer,
    mimeType: params.mimeType,
    fileName: `huggingface-extras-${Date.now()}.${ext}`,
    metadata: {
      provider: PROVIDER_ID,
      capability: "video",
      model: params.modelId,
      prompt: params.prompt,
    },
  };
}

export function buildHuggingFaceExtrasVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: PROVIDER_ID,
    label: "Hugging Face (Extras)",
    defaultModel: DEFAULT_VIDEO_MODEL,
    models: [...KNOWN_VIDEO_MODELS],
    capabilities: {
      generate: {
        maxVideos: 1,
        supportsAspectRatio: false,
        supportsResolution: true,
      },
      imageToVideo: {
        enabled: false,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    isConfigured: () => true,
    async generateVideo(req: VideoGenerationRequest): Promise<VideoGenerationResult> {
      const auth = await resolveApiKeyForProvider({
        provider: PROVIDER_ID,
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      const apiKey = auth?.apiKey;
      if (!apiKey) {
        throw new Error(
          "huggingface-extras video: HF API key not configured. Set HUGGINGFACE_HUB_TOKEN/HF_TOKEN.",
        );
      }
      const modelId = req.model?.trim() || DEFAULT_VIDEO_MODEL;
      const providerModelId = await resolveReplicateProviderId(modelId, apiKey);

      const controller = new AbortController();
      const timeoutMs =
        typeof req.timeoutMs === "number" && req.timeoutMs > 0 ? req.timeoutMs : 600_000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const prediction = await postReplicatePrediction({
          apiKey,
          providerModelId,
          prompt: req.prompt,
          signal: controller.signal,
        });
        const predictionId = prediction.id;
        if (!predictionId) {
          throw new Error("huggingface-extras video: replicate did not return a prediction id");
        }
        const finalPrediction =
          prediction.status === "succeeded"
            ? prediction
            : await pollReplicatePrediction({
                apiKey,
                predictionId,
                timeoutMs,
                signal: controller.signal,
              });
        const outputUrl = pickOutputUrl(finalPrediction);
        const { buffer, mimeType } = await fetchVideoBytes(outputUrl);
        return {
          videos: [
            buildVideoAsset({
              buffer,
              mimeType,
              modelId,
              prompt: req.prompt,
            }),
          ],
          model: modelId,
          metadata: {
            provider: PROVIDER_ID,
            providerModelId,
            predictionId,
          },
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
