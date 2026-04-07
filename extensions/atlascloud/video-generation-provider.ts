// extensions/atlascloud/video-generation-provider.ts
// Atlas Cloud video generation provider — HTTP transport, auth wiring, and
// the VideoGenerationProvider factory. The pure schema-driven request body
// builder lives in `./body-builder.ts` so it can be tested without loading
// any SDK runtime modules.
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import {
  fetchWithSsrFGuard,
  type SsrFPolicy,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
} from "openclaw/plugin-sdk/ssrf-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationSourceAsset,
} from "openclaw/plugin-sdk/video-generation";
import { buildAtlasCloudVideoBody } from "./body-builder.js";
import { REGISTERED_ATLAS_MODELS } from "./model-schemas.js";

// Re-export so existing tests and external consumers that imported the body
// builder from this module keep working.
export { buildAtlasCloudVideoBody } from "./body-builder.js";

const DEFAULT_BASE_URL = "https://api.atlascloud.ai";
const SUBMIT_PATH = "/api/v1/model/generateVideo";
const UPLOAD_PATH = "/api/v1/model/uploadMedia";
// Different model docs reference different polling paths; try each.
const RESULT_PATHS = ["/api/v1/model/result", "/api/v1/model/prediction"] as const;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const UPLOAD_HTTP_TIMEOUT_MS = 60_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 5_000;
// Inline base64 is fine for small images, but anything larger is wasteful in
// the request body and starts hitting per-model size limits (Kling: 10MB).
// Anything at or above this threshold is uploaded via /uploadMedia first.
const INLINE_BASE64_THRESHOLD_BYTES = 2 * 1024 * 1024; // 2 MiB

const DEFAULT_ATLASCLOUD_VIDEO_MODEL = "google/veo3.1-fast/text-to-video";

// =============================================================================
// HTTP transport
// =============================================================================
let atlasFetchGuard = fetchWithSsrFGuard;
export function _setAtlasFetchGuardForTesting(
  impl: typeof fetchWithSsrFGuard | null,
): void {
  atlasFetchGuard = impl ?? fetchWithSsrFGuard;
}

function buildPolicy(allowPrivateNetwork: boolean): SsrFPolicy | undefined {
  return allowPrivateNetwork ? ssrfPolicyFromDangerouslyAllowPrivateNetwork(true) : undefined;
}

type AtlasSubmitResponse = {
  code?: number;
  message?: string;
  data?: { id?: string; urls?: { get?: string } & Record<string, string> };
};

type AtlasResultResponse = {
  code?: number;
  message?: string;
  // Some failure paths surface a numeric vendor error code at the top level.
  error_code?: number;
  data?: {
    id?: string;
    model?: string;
    status?: string;
    outputs?: string[] | null;
    // The real API returns `null` (not `[]`) when there are no NSFW flags.
    has_nsfw_contents?: boolean[] | null;
    created_at?: string;
    // Failure detail. When the upstream provider rejects a request, this is
    // the cleanest error string — `message` at the top level wraps the entire
    // upstream JSON response and is not human-friendly.
    error?: string;
    executionTime?: number;
    timings?: { inference?: number };
    urls?: { get?: string } & Record<string, string>;
  };
};

async function fetchAtlasJson<T>(params: {
  url: string;
  init?: RequestInit;
  timeoutMs: number;
  policy: SsrFPolicy | undefined;
  dispatcherPolicy: Parameters<typeof fetchWithSsrFGuard>[0]["dispatcherPolicy"];
  auditContext: string;
  errorContext: string;
}): Promise<T> {
  const { response, release } = await atlasFetchGuard({
    url: params.url,
    init: params.init,
    timeoutMs: params.timeoutMs,
    policy: params.policy,
    dispatcherPolicy: params.dispatcherPolicy,
    auditContext: params.auditContext,
  });
  try {
    await assertOkOrThrowHttpError(response, params.errorContext);
    return (await response.json()) as T;
  } finally {
    await release();
  }
}

async function pollAtlasResult(args: {
  baseUrl: string;
  predictionId: string;
  /** Canonical poll URL returned by the submit response (`data.urls.get`). */
  preferredUrl?: string;
  headers: Headers;
  timeoutMs: number;
  policy: SsrFPolicy | undefined;
  dispatcherPolicy: Parameters<typeof fetchWithSsrFGuard>[0]["dispatcherPolicy"];
}): Promise<AtlasResultResponse["data"]> {
  const deadline = Date.now() + args.timeoutMs;
  let lastStatus = "unknown";
  // Prefer the canonical URL from submit's `data.urls.get`. Fall back to the
  // documented `result/` and `prediction/` paths in case it is missing.
  const candidates = [
    ...(args.preferredUrl ? [args.preferredUrl] : []),
    ...RESULT_PATHS.map((p) => `${args.baseUrl}${p}/${args.predictionId}`),
  ];
  while (Date.now() < deadline) {
    let payload: AtlasResultResponse | undefined;
    for (const url of candidates) {
      try {
        payload = await fetchAtlasJson<AtlasResultResponse>({
          url,
          init: { method: "GET", headers: args.headers },
          timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
          policy: args.policy,
          dispatcherPolicy: args.dispatcherPolicy,
          auditContext: "atlascloud-video-status",
          errorContext: "Atlas Cloud video status request failed",
        });
        if (payload.data) break;
      } catch {
        // Try the next candidate path.
      }
    }
    const data = payload?.data;
    const status = data?.status?.toLowerCase().trim();
    if (status) lastStatus = status;
    if (status === "completed" || status === "succeeded") return data;
    if (status === "failed" || status === "cancelled") {
      // Prefer `data.error` (clean upstream message); fall back to top-level
      // `message` (which on failure wraps the entire upstream JSON body, but
      // is better than nothing).
      const detail =
        data?.error?.trim() ||
        payload?.message?.trim() ||
        `Atlas Cloud video generation ${status}`;
      throw new Error(detail);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Atlas Cloud video generation did not finish in time (last status: ${lastStatus})`,
  );
}

async function downloadAtlasVideo(
  url: string,
  policy: SsrFPolicy | undefined,
): Promise<GeneratedVideoAsset> {
  const { response, release } = await atlasFetchGuard({
    url,
    timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    policy,
    auditContext: "atlascloud-video-download",
  });
  try {
    await assertOkOrThrowHttpError(response, "Atlas Cloud generated video download failed");
    const mimeType = response.headers.get("content-type")?.trim() || "video/mp4";
    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType,
      fileName: `video-1.${mimeType.includes("webm") ? "webm" : "mp4"}`,
    };
  } finally {
    await release();
  }
}

// =============================================================================
// Media upload (POST /api/v1/model/uploadMedia)
//
// Atlas Cloud accepts both base64 data URLs and public URLs in the image /
// images / videos request fields. For small images we keep the simple inline
// path; once a buffer crosses INLINE_BASE64_THRESHOLD_BYTES we POST it to
// /uploadMedia first and use the returned `download_url` instead — this
// avoids per-model size limits (Kling: 10 MB) and keeps submit bodies small.
// =============================================================================

type AtlasUploadResponse = {
  code?: number;
  message?: string;
  data?: {
    type?: string;
    download_url?: string;
    filename?: string;
    size?: number;
  };
};

function pickMimeType(asset: VideoGenerationSourceAsset): string {
  return asset.mimeType?.trim() || "application/octet-stream";
}

function pickFilename(asset: VideoGenerationSourceAsset, fallback: string): string {
  const explicit = asset.fileName?.trim();
  if (explicit) return explicit;
  const mime = pickMimeType(asset);
  if (mime.startsWith("image/")) return `${fallback}.${mime.split("/")[1] ?? "png"}`;
  if (mime.startsWith("video/")) return `${fallback}.${mime.split("/")[1] ?? "mp4"}`;
  return fallback;
}

/**
 * Upload a single Buffer to Atlas Cloud's `/model/uploadMedia` endpoint and
 * return the public `download_url`. The endpoint is multipart/form-data with
 * a single `file` field. The response shape is taken from the official
 * `AtlasCloudAI/mcp-server` types.
 */
async function uploadAtlasCloudMedia(args: {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  baseUrl: string;
  headers: Headers;
  policy: SsrFPolicy | undefined;
  dispatcherPolicy: Parameters<typeof fetchWithSsrFGuard>[0]["dispatcherPolicy"];
}): Promise<string> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([args.buffer], { type: args.mimeType }),
    args.filename,
  );

  // Strip the JSON Content-Type header inherited from the submit config so
  // fetch can set the multipart boundary itself.
  const uploadHeaders = new Headers(args.headers);
  uploadHeaders.delete("content-type");

  const { response, release } = await atlasFetchGuard({
    url: `${args.baseUrl}${UPLOAD_PATH}`,
    init: { method: "POST", headers: uploadHeaders, body: form },
    timeoutMs: UPLOAD_HTTP_TIMEOUT_MS,
    policy: args.policy,
    dispatcherPolicy: args.dispatcherPolicy,
    auditContext: "atlascloud-media-upload",
  });
  try {
    await assertOkOrThrowHttpError(response, "Atlas Cloud media upload failed");
    const payload = (await response.json()) as AtlasUploadResponse;
    const url = payload.data?.download_url?.trim();
    if (!url) {
      throw new Error(
        `Atlas Cloud upload response missing download_url (code=${payload.code ?? "?"}): ${payload.message ?? ""}`,
      );
    }
    return url;
  } finally {
    await release();
  }
}

/**
 * Mutate every input asset in `req` whose buffer exceeds the inline threshold
 * to use the uploaded `download_url` as its URL. Buffers below the threshold
 * remain inline (cheaper one-shot path). Returns the same request reference
 * for chaining.
 *
 * Implementation note: we walk both `inputImages` and `inputVideos`. Videos
 * almost always exceed the threshold and must be uploaded.
 */
async function prepareAtlasCloudInputs(
  req: VideoGenerationRequest,
  uploadCtx: {
    baseUrl: string;
    headers: Headers;
    policy: SsrFPolicy | undefined;
    dispatcherPolicy: Parameters<typeof fetchWithSsrFGuard>[0]["dispatcherPolicy"];
  },
): Promise<VideoGenerationRequest> {
  const upload = async (asset: VideoGenerationSourceAsset, fallbackName: string) => {
    if (asset.url?.trim()) return asset;
    if (!asset.buffer) return asset;
    if (asset.buffer.byteLength < INLINE_BASE64_THRESHOLD_BYTES) return asset;
    const url = await uploadAtlasCloudMedia({
      buffer: asset.buffer,
      filename: pickFilename(asset, fallbackName),
      mimeType: pickMimeType(asset),
      baseUrl: uploadCtx.baseUrl,
      headers: uploadCtx.headers,
      policy: uploadCtx.policy,
      dispatcherPolicy: uploadCtx.dispatcherPolicy,
    });
    return { ...asset, url };
  };

  const inputImages = req.inputImages
    ? await Promise.all(req.inputImages.map((a, i) => upload(a, `image-${i + 1}`)))
    : undefined;
  const inputVideos = req.inputVideos
    ? await Promise.all(req.inputVideos.map((a, i) => upload(a, `video-${i + 1}`)))
    : undefined;

  return { ...req, inputImages, inputVideos };
}

// =============================================================================
// Provider factory
// =============================================================================
export function buildAtlasCloudVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "atlascloud",
    aliases: ["atlas-cloud", "atlas"],
    label: "Atlas Cloud",
    defaultModel: DEFAULT_ATLASCLOUD_VIDEO_MODEL,
    models: [...REGISTERED_ATLAS_MODELS],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({ provider: "atlascloud", agentDir }),
    capabilities: {
      generate: {
        maxVideos: 1,
        supportedDurationSeconds: [3, 4, 5, 6, 7, 8, 9, 10, 12, 15],
        aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
        resolutions: ["480P", "720P", "768P", "1080P"],
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
        supportsAudio: true,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        // Vidu reference-to-video accepts 1-4 reference images.
        maxInputImages: 4,
        supportsAspectRatio: true,
        supportsResolution: true,
        supportsSize: true,
        supportsAudio: true,
      },
      videoToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputVideos: 1,
      },
    },

    async generateVideo(req) {
      const auth = await resolveApiKeyForProvider({
        provider: "atlascloud",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) throw new Error("Atlas Cloud API key missing");

      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: (
            req.cfg?.models?.providers as Record<string, { baseUrl?: string }> | undefined
          )?.atlascloud?.baseUrl?.trim(),
          defaultBaseUrl: DEFAULT_BASE_URL,
          allowPrivateNetwork: false,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            "Content-Type": "application/json",
          },
          provider: "atlascloud",
          capability: "video",
          transport: "http",
        });

      const policy = buildPolicy(allowPrivateNetwork);

      // Pre-step: upload any large input buffers via /uploadMedia and replace
      // them with the returned download_url before building the submit body.
      // Small buffers stay inline (base64) to avoid an extra round trip.
      const uploadedReq = await prepareAtlasCloudInputs(req, {
        baseUrl,
        headers,
        policy,
        dispatcherPolicy,
      });
      const body = buildAtlasCloudVideoBody(uploadedReq);

      // Step 1: submit the task.
      const submitted = await fetchAtlasJson<AtlasSubmitResponse>({
        url: `${baseUrl}${SUBMIT_PATH}`,
        init: { method: "POST", headers, body: JSON.stringify(body) },
        timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
        policy,
        dispatcherPolicy,
        auditContext: "atlascloud-video-submit",
        errorContext: "Atlas Cloud video generation submit failed",
      });
      const predictionId = submitted.data?.id?.trim();
      if (!predictionId) {
        throw new Error(
          `Atlas Cloud video submit response missing prediction id (code=${submitted.code ?? "?"}): ${submitted.message ?? ""}`,
        );
      }

      // Step 2: poll until completed. Prefer the canonical URL the submit
      // response gave us; fall back to constructed paths if missing.
      const result = await pollAtlasResult({
        baseUrl,
        predictionId,
        preferredUrl: submitted.data?.urls?.get?.trim() || undefined,
        headers,
        timeoutMs: req.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
        policy,
        dispatcherPolicy,
      });

      // Step 3: download the first output. `outputs` is `null` until the
      // task completes; we should only reach this point on `completed`.
      const outputUrl = result?.outputs?.find?.((u) => u?.trim());
      if (!outputUrl) {
        throw new Error("Atlas Cloud video generation completed but returned no output URL");
      }
      const video = await downloadAtlasVideo(outputUrl, policy);

      return {
        videos: [video],
        model: result?.model ?? (body.model as string),
        metadata: {
          predictionId,
          ...(result?.created_at ? { createdAt: result.created_at } : {}),
          // `has_nsfw_contents` is `null` (not `[]`) when there are no flags;
          // guard against null before reading `.length`.
          ...(Array.isArray(result?.has_nsfw_contents) && result.has_nsfw_contents.length > 0
            ? { hasNsfwContents: result.has_nsfw_contents }
            : {}),
        },
      };
    },
  };
}
