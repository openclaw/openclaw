// Venice video generation: queue a job on /video/queue, poll /video/retrieve
// until the mp4 bytes come back. Model constraints come from the live catalog.
import {
  readGeneratedVideoAsset,
  resolveGeneratedMediaMaxBytes,
} from "openclaw/plugin-sdk/media-generation-runtime";
import { resolvePositiveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  createProviderOperationDeadline,
  waitProviderOperationPollInterval,
} from "openclaw/plugin-sdk/provider-http";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationModeCapabilities,
  VideoGenerationProvider,
  VideoGenerationProviderCapabilities,
  VideoGenerationRequest,
  VideoGenerationResolution,
  VideoGenerationSourceAsset,
} from "openclaw/plugin-sdk/video-generation";
import { fetchVeniceLiveModelSpec } from "./models.js";
import {
  fetchVeniceVideo,
  postVeniceJson,
  readVeniceJson,
  VENICE_VIDEO_MALFORMED_RESPONSE,
  type VeniceVideoHttp,
} from "./video-generation-transport.js";

const PROVIDER_ID = "venice";
// Venice encodes the input mode in the model id. The text/image pair below is
// the plugin default; callers who omit `model` and attach an image get the
// image-to-video sibling instead of a guaranteed 400 from the text model.
const DEFAULT_TEXT_TO_VIDEO_MODEL = "wan-3-0-text-to-video";
const DEFAULT_IMAGE_TO_VIDEO_MODEL = "wan-3-0-image-to-video";
const DEFAULT_DURATION_SECONDS = 5;
const DEFAULT_OPERATION_TIMEOUT_MS = 1_200_000;
const POLL_INTERVAL_MS = 5_000;
// Retrieve polls run for minutes behind Venice's edge; ride out short 5xx
// blips instead of losing a paid job on the SDK's single default retry.
const POLL_RETRY = { attempts: 4, baseDelayMs: 1_000, maxDelayMs: 5_000 };

// Advisory list for `video_generate action=list`; any live Venice video model id is accepted.
const VENICE_VIDEO_MODELS = [
  DEFAULT_TEXT_TO_VIDEO_MODEL,
  DEFAULT_IMAGE_TO_VIDEO_MODEL,
  "wan-3-0-reference-to-video",
  "seedance-2-0-text-to-video-basic",
  "seedance-2-0-image-to-video-basic",
  "kling-v3-pro-text-to-video",
  "kling-v3-pro-image-to-video",
  "veo3.1-fast-text-to-video",
  "veo3.1-fast-image-to-video",
  "minimax-h3-text-to-video",
  "minimax-h3-image-to-video",
];
const VENICE_VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const VENICE_VIDEO_RESOLUTIONS: VideoGenerationResolution[] = ["480P", "720P", "1080P"];

type VeniceVideoConstraints = {
  modelType: "text-to-video" | "image-to-video" | "video";
  durations: number[];
  aspectRatios: string[];
  resolutions: VideoGenerationResolution[];
  audioConfigurable: boolean;
  audioInput: boolean;
  videoInput: boolean;
};

function parseDurationSeconds(value: unknown): number | undefined {
  const match = /^(\d{1,3})s$/iu.exec(normalizeOptionalString(value) ?? "");
  return match ? Number.parseInt(match[1] ?? "", 10) : undefined;
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const normalized = normalizeOptionalString(entry);
        return normalized ? [normalized] : [];
      })
    : [];
}

// Venice constraint ids are lowercase (`720p`, `4k`); core resolution labels are uppercase.
function toCoreResolution(value: string): VideoGenerationResolution {
  return value.toUpperCase();
}

function readVeniceVideoConstraints(spec: unknown): VeniceVideoConstraints | undefined {
  if (!isRecord(spec) || !isRecord(spec.constraints)) {
    return undefined;
  }
  const constraints = spec.constraints;
  const modelType = normalizeOptionalString(constraints.model_type);
  if (modelType !== "text-to-video" && modelType !== "image-to-video" && modelType !== "video") {
    return undefined;
  }
  return {
    modelType,
    durations: readStringList(constraints.durations).flatMap((entry) => {
      const seconds = parseDurationSeconds(entry);
      return seconds === undefined ? [] : [seconds];
    }),
    aspectRatios: readStringList(constraints.aspect_ratios),
    resolutions: readStringList(constraints.resolutions).map(toCoreResolution),
    audioConfigurable: constraints.audio_configurable === true,
    audioInput: constraints.audio_input === true,
    videoInput: constraints.video_input === true,
  };
}

async function fetchVeniceVideoConstraints(
  model: string,
): Promise<VeniceVideoConstraints | undefined> {
  return readVeniceVideoConstraints(await fetchVeniceLiveModelSpec("video", model));
}

// Core always lists `generate` as a supported mode, so a text-only request
// against an image- or video-only Venice model must be rejected here, before
// it is queued and billed.
function assertVeniceVideoInputs(
  model: string,
  constraints: VeniceVideoConstraints | undefined,
  req: VideoGenerationRequest,
): void {
  if (!constraints) {
    return;
  }
  const imageCount = req.inputImages?.length ?? 0;
  const videoCount = req.inputVideos?.length ?? 0;
  // Reference models report `image-to-video` but may also take videos alone.
  const videoOnlyAccepted = constraints.videoInput && videoCount > 0;
  if (constraints.modelType === "image-to-video" && imageCount === 0 && !videoOnlyAccepted) {
    throw new Error(`venice model ${model} requires an image input`);
  }
  if (constraints.modelType === "video" && videoCount === 0) {
    throw new Error(`venice model ${model} requires a video input`);
  }
  if (constraints.modelType === "text-to-video" && imageCount + videoCount > 0) {
    throw new Error(`venice model ${model} accepts a text prompt only`);
  }
}

function modeCapabilitiesFromConstraints(
  constraints: VeniceVideoConstraints,
): VideoGenerationModeCapabilities {
  return {
    ...(constraints.durations.length > 0
      ? {
          supportedDurationSeconds: constraints.durations,
          maxDurationSeconds: Math.max(...constraints.durations),
        }
      : {}),
    ...(constraints.aspectRatios.length > 0 ? { aspectRatios: constraints.aspectRatios } : {}),
    ...(constraints.resolutions.length > 0 ? { resolutions: constraints.resolutions } : {}),
    supportsAspectRatio: constraints.aspectRatios.length > 0,
    supportsResolution: constraints.resolutions.length > 0,
    supportsAudio: constraints.audioConfigurable,
  };
}

function capabilitiesFromVeniceVideoConstraints(
  model: string,
  constraints: VeniceVideoConstraints,
): VideoGenerationProviderCapabilities {
  const isReferenceModel = model.includes("reference-to-video");
  const acceptsImages = constraints.modelType === "image-to-video";
  const mode = {
    ...modeCapabilitiesFromConstraints(constraints),
    // `audio_url` plus up to 10 `reference_audio_urls` when the model takes audio.
    maxInputAudios: constraints.audioInput ? 10 : 0,
  };
  return {
    generate: mode,
    imageToVideo: {
      ...mode,
      enabled: acceptsImages,
      // Reference models take up to 30 `reference_image_urls` (the cap in
      // Venice's /video/queue schema; live constraints publish no per-model
      // counts); image-to-video models take `image_url` plus optional `end_image_url`.
      maxInputImages: acceptsImages ? (isReferenceModel ? 30 : 2) : 0,
    },
    videoToVideo: {
      ...mode,
      enabled: constraints.videoInput,
      // `video_url` plus up to 10 `reference_video_urls` (Venice's schema cap);
      // reference models may also mix images in, which core routes through videoToVideo.
      maxInputVideos: constraints.videoInput ? (isReferenceModel ? 10 : 1) : 0,
      maxInputImages: isReferenceModel ? 30 : 0,
    },
  };
}

// Core resolves capabilities for the configured model before the provider can
// swap it, so the text default must advertise its image sibling's image mode or
// image requests are skipped before `resolveVeniceVideoModel` ever runs.
async function resolveVeniceModelCapabilities(
  model: string,
): Promise<VideoGenerationProviderCapabilities | undefined> {
  const constraints = await fetchVeniceVideoConstraints(model);
  if (!constraints) {
    return undefined;
  }
  const capabilities = capabilitiesFromVeniceVideoConstraints(model, constraints);
  if (model !== DEFAULT_TEXT_TO_VIDEO_MODEL) {
    return capabilities;
  }
  const sibling = await fetchVeniceVideoConstraints(DEFAULT_IMAGE_TO_VIDEO_MODEL);
  if (!sibling) {
    return capabilities;
  }
  return {
    ...capabilities,
    imageToVideo: capabilitiesFromVeniceVideoConstraints(DEFAULT_IMAGE_TO_VIDEO_MODEL, sibling)
      .imageToVideo,
  };
}

function resolveVeniceVideoModel(req: VideoGenerationRequest): string {
  const model = normalizeOptionalString(req.model) ?? DEFAULT_TEXT_TO_VIDEO_MODEL;
  const hasImageInput = (req.inputImages?.length ?? 0) > 0;
  return model === DEFAULT_TEXT_TO_VIDEO_MODEL && hasImageInput
    ? DEFAULT_IMAGE_TO_VIDEO_MODEL
    : model;
}

function resolveAssetUrl(asset: VideoGenerationSourceAsset, defaultMimeType: string): string {
  const url = normalizeOptionalString(asset.url);
  if (url) {
    return url;
  }
  if (!asset.buffer) {
    throw new Error("venice video reference input is missing media data");
  }
  const mimeType = normalizeOptionalString(asset.mimeType) ?? defaultMimeType;
  return `data:${mimeType};base64,${asset.buffer.toString("base64")}`;
}

function assetRole(asset: VideoGenerationSourceAsset): string | undefined {
  return normalizeOptionalString(asset.role)?.toLowerCase();
}

type VeniceMediaKeys = {
  single: string;
  references: string;
  referenceRole: string;
  defaultMimeType: string;
  end?: { role: string; key: string };
};

// First unlabeled asset fills the single slot; labeled references and any
// overflow go to the list field. Images additionally map `last_frame`.
function applyMediaInputs(
  body: Record<string, unknown>,
  assets: VideoGenerationSourceAsset[],
  keys: VeniceMediaKeys,
) {
  const references: string[] = [];
  for (const asset of assets) {
    const url = resolveAssetUrl(asset, keys.defaultMimeType);
    const role = assetRole(asset);
    if (keys.end && role === keys.end.role) {
      body[keys.end.key] = url;
    } else if (role === keys.referenceRole || body[keys.single] !== undefined) {
      references.push(url);
    } else {
      body[keys.single] = url;
    }
  }
  if (references.length > 0) {
    body[keys.references] = references;
  }
}

// Venice requires `aspect_ratio` on models that publish a ratio list and
// otherwise defaults `resolution` to the top (most expensive) tier, so an
// omitted control is filled from the live constraints: the first plain ratio
// and the cheapest tier.
function defaultAspectRatio(constraints: VeniceVideoConstraints | undefined): string | undefined {
  return constraints?.aspectRatios.find((ratio) => /^\d+:\d+$/u.test(ratio));
}

function resolutionRank(resolution: string): number {
  const match = /^(\d+)[pP]$/u.exec(resolution);
  if (match) {
    return Number.parseInt(match[1] ?? "", 10);
  }
  const kMatch = /^(\d+)[kK]$/u.exec(resolution);
  return kMatch ? Number.parseInt(kMatch[1] ?? "", 10) * 1000 : Number.POSITIVE_INFINITY;
}

function cheapestResolution(constraints: VeniceVideoConstraints | undefined): string | undefined {
  const ranked = (constraints?.resolutions ?? [])
    .filter((resolution) => Number.isFinite(resolutionRank(resolution)))
    .toSorted((left, right) => resolutionRank(left) - resolutionRank(right));
  return ranked[0];
}

function buildVeniceVideoRequestBody(
  req: VideoGenerationRequest,
  model: string,
  constraints?: VeniceVideoConstraints,
): Record<string, unknown> {
  const durationSeconds =
    typeof req.durationSeconds === "number" && Number.isFinite(req.durationSeconds)
      ? Math.max(1, Math.round(req.durationSeconds))
      : DEFAULT_DURATION_SECONDS;
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    // Venice requires `duration` as a `<n>s` string; core passes seconds.
    duration: `${durationSeconds}s`,
  };
  const aspectRatio = normalizeOptionalString(req.aspectRatio) ?? defaultAspectRatio(constraints);
  if (aspectRatio) {
    body.aspect_ratio = aspectRatio;
  }
  const resolution = normalizeOptionalString(req.resolution) ?? cheapestResolution(constraints);
  if (resolution) {
    body.resolution = resolution.toLowerCase();
  }
  if (typeof req.audio === "boolean") {
    body.audio = req.audio;
  }
  applyMediaInputs(body, req.inputImages ?? [], {
    single: "image_url",
    references: "reference_image_urls",
    referenceRole: "reference_image",
    defaultMimeType: "image/png",
    end: { role: "last_frame", key: "end_image_url" },
  });
  applyMediaInputs(body, req.inputVideos ?? [], {
    single: "video_url",
    references: "reference_video_urls",
    referenceRole: "reference_video",
    defaultMimeType: "video/mp4",
  });
  applyMediaInputs(body, req.inputAudios ?? [], {
    single: "audio_url",
    references: "reference_audio_urls",
    referenceRole: "reference_audio",
    defaultMimeType: "audio/mpeg",
  });
  return body;
}

// The quote is advisory metadata; no quote failure may block generation.
async function quoteVeniceVideo(
  body: Record<string, unknown>,
  http: VeniceVideoHttp,
): Promise<number | undefined> {
  // Venice prices input-video jobs from `reference_video_total_duration`,
  // which needs the media probed; without it the quote is the cheaper
  // no-reference tier, so report nothing rather than a misleading number.
  if (body.video_url !== undefined || body.reference_video_urls !== undefined) {
    return undefined;
  }
  const quoteBody: Record<string, unknown> = { model: body.model, duration: body.duration };
  for (const key of ["aspect_ratio", "resolution", "audio"]) {
    if (body[key] !== undefined) {
      quoteBody[key] = body[key];
    }
  }
  try {
    const { response, release } = await postVeniceJson({
      path: "/video/quote",
      body: quoteBody,
      http,
      stage: "create",
      auditContext: "venice-video-quote",
      errorContext: "venice video quote failed",
    });
    try {
      const payload = await readVeniceJson(response, "venice video quote failed");
      return isRecord(payload) && typeof payload.quote === "number" ? payload.quote : undefined;
    } finally {
      await release();
    }
  } catch {
    return undefined;
  }
}

async function queueVeniceVideo(
  body: Record<string, unknown>,
  http: VeniceVideoHttp,
): Promise<{ queueId: string; downloadUrl?: string }> {
  const { response, release } = await postVeniceJson({
    path: "/video/queue",
    body,
    http,
    // Queueing bills a job and has no idempotency token; the SDK runs the
    // `create` stage exactly once, so a lost response can never queue twice.
    stage: "create",
    auditContext: "venice-video-queue",
    errorContext: "venice video generation failed",
  });
  try {
    const payload = await readVeniceJson(response, "venice video queue failed");
    const queueId = isRecord(payload) ? normalizeOptionalString(payload.queue_id) : undefined;
    if (!queueId) {
      throw new Error(VENICE_VIDEO_MALFORMED_RESPONSE);
    }
    const downloadUrl = isRecord(payload)
      ? normalizeOptionalString(payload.download_url)
      : undefined;
    return { queueId, ...(downloadUrl ? { downloadUrl } : {}) };
  } finally {
    await release();
  }
}

function isVideoResponse(response: Response): boolean {
  return (
    normalizeOptionalString(response.headers.get("content-type")?.split(";")[0])?.startsWith(
      "video/",
    ) === true
  );
}

async function downloadVeniceVideo(
  url: string,
  http: VeniceVideoHttp,
  maxBytes: number,
): Promise<GeneratedVideoAsset> {
  const { response, release } = await fetchVeniceVideo({
    url,
    http,
    stage: "download",
    auditContext: "venice-video-download",
    errorContext: "venice generated video download failed",
  });
  try {
    return await readGeneratedVideoAsset(response, {
      label: "venice generated video download",
      maxBytes,
      validateBinaryResponse: true,
      overflowUrl: url,
    });
  } finally {
    await release();
  }
}

// Privacy cleanup once the asset is in hand. Deleting on retrieve would lose
// a paid result if the body read failed; a failed cleanup loses nothing.
async function completeVeniceVideo(
  model: string,
  queueId: string,
  http: VeniceVideoHttp,
  downloadUrl?: string,
) {
  if (downloadUrl) {
    // Private outputs are served from a presigned URL that stays valid until
    // expiry; Venice revokes it on DELETE, so nobody holding the link can
    // fetch the (possibly sensitive) video after we have it. The URL is on a
    // delivery origin, not api.venice.ai, so the bearer token never goes with it.
    // Revocation and queue cleanup are independent; try both.
    try {
      const revoked = await fetchVeniceVideo({
        url: downloadUrl,
        init: { method: "DELETE" },
        http,
        stage: "create",
        auditContext: "venice-video-revoke",
        errorContext: "venice video download revoke failed",
      });
      await revoked.release();
    } catch {
      // The link expires on Venice's schedule; the queue cleanup below still runs.
    }
  }
  try {
    const { release } = await postVeniceJson({
      path: "/video/complete",
      body: { model, queue_id: queueId },
      http,
      stage: "create",
      auditContext: "venice-video-complete",
      errorContext: "venice video cleanup failed",
    });
    await release();
  } catch {
    // Media stays until Venice's own expiry; nothing user-visible is lost.
  }
}

// Venice's retrieve endpoint answers JSON `{status: "PROCESSING"}` while the job
// runs and the raw video bytes once done. Private models return JSON
// `COMPLETED` and hand the bytes out through the queue-time `download_url`.
async function retrieveVeniceVideo(params: {
  model: string;
  queueId: string;
  downloadUrl?: string;
  http: VeniceVideoHttp;
  maxBytes: number;
}): Promise<GeneratedVideoAsset> {
  for (;;) {
    const { response, release } = await postVeniceJson({
      path: "/video/retrieve",
      body: { model: params.model, queue_id: params.queueId },
      http: params.http,
      stage: "poll",
      retry: POLL_RETRY,
      auditContext: "venice-video-retrieve",
      errorContext: "venice video status request failed",
    });
    try {
      if (isVideoResponse(response)) {
        const video = await readGeneratedVideoAsset(response, {
          label: "venice generated video",
          maxBytes: params.maxBytes,
        });
        await completeVeniceVideo(params.model, params.queueId, params.http);
        return video;
      }
      const payload = await readVeniceJson(response, "venice video status request failed");
      const status = isRecord(payload) ? normalizeOptionalString(payload.status) : undefined;
      if (!status) {
        throw new Error(VENICE_VIDEO_MALFORMED_RESPONSE);
      }
      if (status.toUpperCase() === "COMPLETED") {
        if (!params.downloadUrl) {
          throw new Error(VENICE_VIDEO_MALFORMED_RESPONSE);
        }
        const video = await downloadVeniceVideo(params.downloadUrl, params.http, params.maxBytes);
        // An oversized private result is delivered by URL, so that link must
        // stay live; cleanup only once the bytes are in hand.
        if (video.buffer) {
          await completeVeniceVideo(params.model, params.queueId, params.http, params.downloadUrl);
        }
        return video;
      }
      if (status.toUpperCase() !== "PROCESSING") {
        // Venice documents only PROCESSING/COMPLETED; anything else is a
        // provider-signaled terminal state, so surface it instead of "malformed".
        const detail = isRecord(payload) ? normalizeOptionalString(payload.error) : undefined;
        throw new Error(
          `venice video generation ${status.toLowerCase()}${detail ? `: ${detail}` : ""}`,
        );
      }
    } finally {
      await release();
    }
    await waitProviderOperationPollInterval({
      deadline: params.http.deadline,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
  }
}

export function buildVeniceVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: PROVIDER_ID,
    label: "Venice",
    defaultModel: DEFAULT_TEXT_TO_VIDEO_MODEL,
    defaultTimeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
    models: [...VENICE_VIDEO_MODELS],
    isConfigured: (ctx) => isProviderApiKeyConfigured({ provider: PROVIDER_ID, ...ctx }),
    capabilities: {
      generate: {
        maxVideos: 1,
        maxDurationSeconds: 30,
        maxInputAudios: 1,
        aspectRatios: [...VENICE_VIDEO_ASPECT_RATIOS],
        resolutions: [...VENICE_VIDEO_RESOLUTIONS],
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsAudio: true,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: 2,
        maxInputAudios: 1,
        maxDurationSeconds: 30,
        aspectRatios: [...VENICE_VIDEO_ASPECT_RATIOS],
        resolutions: [...VENICE_VIDEO_RESOLUTIONS],
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsAudio: true,
      },
      videoToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputVideos: 1,
        maxInputAudios: 1,
        supportsAspectRatio: false,
        supportsResolution: true,
        supportsAudio: false,
      },
    },
    resolveModelCapabilities: ({ model }) => resolveVeniceModelCapabilities(model),
    async generateVideo(req) {
      const model = resolveVeniceVideoModel(req);
      const constraints = await fetchVeniceVideoConstraints(model);
      assertVeniceVideoInputs(model, constraints, req);
      const body = buildVeniceVideoRequestBody(req, model, constraints);
      const auth = await resolveApiKeyForProvider({
        provider: PROVIDER_ID,
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("venice API key missing");
      }
      const http: VeniceVideoHttp = {
        headers: {
          Authorization: `Bearer ${auth.apiKey}`,
          "Content-Type": "application/json",
        },
        deadline: createProviderOperationDeadline({
          timeoutMs: resolvePositiveTimerTimeoutMs(req.timeoutMs, DEFAULT_OPERATION_TIMEOUT_MS),
          label: "venice video generation",
        }),
      };
      const quoteUsd = await quoteVeniceVideo(body, http);
      const { queueId, downloadUrl } = await queueVeniceVideo(body, http);
      const video = await retrieveVeniceVideo({
        model,
        queueId,
        downloadUrl,
        http,
        maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, "video"),
      });
      return {
        videos: [video],
        model,
        metadata: {
          queueId,
          ...(quoteUsd !== undefined ? { quoteUsd } : {}),
        },
      };
    },
  };
}
