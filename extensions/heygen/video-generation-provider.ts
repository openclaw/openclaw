import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  fetchWithTimeoutGuarded,
  postJsonRequest,
  resolveProviderOperationTimeoutMs,
  resolveProviderHttpRequestConfig,
  waitProviderOperationPollInterval,
} from "openclaw/plugin-sdk/provider-http";

type HeyGenGuardedOptions = NonNullable<Parameters<typeof fetchWithTimeoutGuarded>[4]>;
type HeyGenDispatcherPolicy = HeyGenGuardedOptions["dispatcherPolicy"];
type HeyGenTransportPolicy = {
  allowPrivateNetwork: boolean;
  dispatcherPolicy: HeyGenDispatcherPolicy;
};
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationRequest,
  VideoGenerationResult,
} from "openclaw/plugin-sdk/video-generation";

const DEFAULT_HEYGEN_BASE_URL = "https://api.heygen.com";
const DEFAULT_HEYGEN_MODEL = "video_agent_v3";
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_FAST_MS = 5_000;
const POLL_INTERVAL_MEDIUM_MS = 15_000;
const POLL_INTERVAL_SLOW_MS = 30_000;
const POLL_FAST_ATTEMPTS = 6;
const POLL_MEDIUM_ATTEMPTS = 12;
const MAX_POLL_ATTEMPTS = 240;
const THINKING_FAST_FAIL_POLLS = 8;
const MAX_DURATION_SECONDS = 300;
const MAX_FILE_ATTACHMENTS = 20;
const HEYGEN_PROVIDER_VERSION = "0.1.0";
const HEYGEN_USER_AGENT = `OpenClaw-HeyGen-Provider/${HEYGEN_PROVIDER_VERSION}`;
const HEYGEN_PARTNER_SOURCE = "openclaw-plugin";

function computePollIntervalMs(attempt: number): number {
  if (attempt < POLL_FAST_ATTEMPTS) {
    return POLL_INTERVAL_FAST_MS;
  }
  if (attempt < POLL_FAST_ATTEMPTS + POLL_MEDIUM_ATTEMPTS) {
    return POLL_INTERVAL_MEDIUM_MS;
  }
  return POLL_INTERVAL_SLOW_MS;
}

const HEYGEN_ASPECT_RATIOS = ["16:9", "9:16"] as const;
type HeyGenOrientation = "landscape" | "portrait";

type SessionStatus =
  | "thinking"
  | "waiting_for_input"
  | "reviewing"
  | "generating"
  | "completed"
  | "failed";

type VideoFileStatus = "pending" | "processing" | "completed" | "failed";

type CreateSessionResponse = {
  error?: { code?: string | number; message?: string } | null;
  data?: {
    session_id?: string;
    status?: SessionStatus;
    video_id?: string | null;
    created_at?: number;
  };
};

type GetSessionResponse = {
  error?: { code?: string | number; message?: string } | null;
  data?: {
    session_id?: string;
    status?: SessionStatus;
    progress?: number;
    title?: string | null;
    video_id?: string | null;
    created_at?: number;
    messages?: unknown[];
  };
};

type GetVideoResponse = {
  error?: { code?: string | number; message?: string } | null;
  data?: {
    id?: string;
    status?: VideoFileStatus;
    video_url?: string | null;
    thumbnail_url?: string | null;
    duration?: number | null;
    failure_code?: string | null;
    failure_message?: string | null;
  };
};

// Extend with `{ type: "asset_id"; asset_id: string }` when callers need to reference
// pre-uploaded HeyGen assets (POST /v3/assets). OpenAPI schema supports it; omitted
// until there's a concrete caller to avoid a dead type surface.
type HeyGenFileAttachment =
  | { type: "url"; url: string }
  | { type: "base64"; media_type: string; data: string };

function resolveHeyGenBaseUrl(req: VideoGenerationRequest): string {
  return (
    normalizeOptionalString(req.cfg?.models?.providers?.heygen?.baseUrl) ?? DEFAULT_HEYGEN_BASE_URL
  );
}

function resolveHeyGenPluginConfig(
  req: VideoGenerationRequest,
): Record<string, unknown> | undefined {
  const entries = req.cfg?.plugins?.entries as Record<string, unknown> | undefined;
  const heygen = entries?.heygen;
  if (!heygen || typeof heygen !== "object") {
    return undefined;
  }
  const config = (heygen as Record<string, unknown>).config;
  return config && typeof config === "object" ? (config as Record<string, unknown>) : undefined;
}

function resolveHeyGenConfigString(req: VideoGenerationRequest, key: string): string | undefined {
  const cfg = resolveHeyGenPluginConfig(req);
  return cfg ? normalizeOptionalString(cfg[key]) : undefined;
}

function aspectRatioToOrientation(aspectRatio: string | undefined): HeyGenOrientation | undefined {
  const ar = normalizeOptionalString(aspectRatio);
  if (!ar) {
    return undefined;
  }
  switch (ar) {
    case "16:9":
      return "landscape";
    case "9:16":
      return "portrait";
    default:
      throw new Error(
        `HeyGen video generation does not support aspect ratio ${ar}. Supported: ${HEYGEN_ASPECT_RATIOS.join(", ")}.`,
      );
  }
}

function resolveProviderOption(opts: Record<string, unknown>, key: string): string | undefined {
  const raw = opts[key];
  if (typeof raw !== "string") {
    return undefined;
  }
  return normalizeOptionalString(raw);
}

function resolveOrientation(
  req: VideoGenerationRequest,
  opts: Record<string, unknown>,
): HeyGenOrientation | undefined {
  const explicit = resolveProviderOption(opts, "orientation");
  if (explicit === "landscape" || explicit === "portrait") {
    return explicit;
  }
  if (explicit) {
    throw new Error(`HeyGen orientation must be 'landscape' or 'portrait'; got '${explicit}'.`);
  }
  return aspectRatioToOrientation(req.aspectRatio);
}

function buildFileAttachments(req: VideoGenerationRequest): HeyGenFileAttachment[] {
  const files: HeyGenFileAttachment[] = [];
  for (const image of req.inputImages ?? []) {
    const url = normalizeOptionalString(image.url);
    if (url) {
      files.push({ type: "url", url });
      continue;
    }
    if (!image.buffer) {
      continue;
    }
    const mediaType = normalizeOptionalString(image.mimeType) ?? "image/png";
    files.push({
      type: "base64",
      media_type: mediaType,
      data: image.buffer.toString("base64"),
    });
  }
  if (files.length > MAX_FILE_ATTACHMENTS) {
    throw new Error(
      `HeyGen Video Agent accepts at most ${MAX_FILE_ATTACHMENTS} file attachments; got ${files.length}.`,
    );
  }
  return files;
}

function buildCreateSessionBody(req: VideoGenerationRequest): Record<string, unknown> {
  const opts = req.providerOptions ?? {};
  const prompt = normalizeOptionalString(req.prompt);
  if (!prompt) {
    throw new Error("HeyGen Video Agent requires a non-empty prompt.");
  }

  const body: Record<string, unknown> = { prompt };

  const mode = resolveProviderOption(opts, "mode");
  body.mode = mode === "chat" ? "chat" : "generate";

  const avatarId =
    resolveProviderOption(opts, "avatar_id") ?? resolveHeyGenConfigString(req, "defaultAvatarId");
  if (avatarId) {
    body.avatar_id = avatarId;
  }
  const voiceId =
    resolveProviderOption(opts, "voice_id") ?? resolveHeyGenConfigString(req, "defaultVoiceId");
  if (voiceId) {
    body.voice_id = voiceId;
  }
  const styleId =
    resolveProviderOption(opts, "style_id") ?? resolveHeyGenConfigString(req, "defaultStyleId");
  if (styleId) {
    body.style_id = styleId;
  }

  const orientation = resolveOrientation(req, opts);
  if (orientation) {
    body.orientation = orientation;
  }

  const files = buildFileAttachments(req);
  if (files.length > 0) {
    body.files = files;
  }

  const callbackUrl = resolveProviderOption(opts, "callback_url");
  if (callbackUrl) {
    body.callback_url = callbackUrl;
  }
  const callbackId = resolveProviderOption(opts, "callback_id");
  if (callbackId) {
    body.callback_id = callbackId;
  }

  const incognito = opts.incognito_mode;
  if (typeof incognito === "boolean") {
    body.incognito_mode = incognito;
  }

  return body;
}

function extractErrorMessage(payload: {
  error?: { code?: string | number; message?: string } | null;
}): string | undefined {
  if (!payload.error) {
    return undefined;
  }
  const message = normalizeOptionalString(payload.error.message);
  if (message) {
    return message;
  }
  const rawCode = payload.error.code;
  const code =
    typeof rawCode === "string"
      ? normalizeOptionalString(rawCode)
      : typeof rawCode === "number"
        ? String(rawCode)
        : undefined;
  if (code) {
    return `HeyGen returned error code ${code}`;
  }
  return "HeyGen returned an error envelope without a message";
}

function translateHeyGenHttpError(status: number, body: string): Error {
  const lower = body.toLowerCase();
  if (status === 401) {
    return new Error("HeyGen API key missing or invalid");
  }
  const isClientError = status >= 400 && status < 500;
  if (status === 402 || (isClientError && /quota|credit|payment required/i.test(body))) {
    return new Error("HeyGen credit limit reached");
  }
  if (status === 404) {
    if (lower.includes("avatar")) {
      return new Error("HeyGen avatar not found. Check providerOptions.avatar_id.");
    }
    if (lower.includes("voice")) {
      return new Error("HeyGen voice not found. Check providerOptions.voice_id.");
    }
    return new Error("HeyGen resource not found");
  }
  if (status === 429) {
    return new Error("HeyGen rate limit exceeded; retry after the Retry-After interval.");
  }
  return new Error(
    `HeyGen Video Agent request failed with status ${status}: ${body || "(empty response body)"}`,
  );
}

function buildGuardedGetOptions(params: {
  policy: HeyGenTransportPolicy;
  auditContext: string;
}): HeyGenGuardedOptions {
  return {
    ...(params.policy.allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
    ...(params.policy.dispatcherPolicy ? { dispatcherPolicy: params.policy.dispatcherPolicy } : {}),
    auditContext: params.auditContext,
  };
}

async function fetchHeyGenJsonGuarded<TPayload>(params: {
  url: string;
  headers: Headers;
  timeoutMs: number;
  fetchFn: typeof fetch;
  policy: HeyGenTransportPolicy;
  auditContext: string;
}): Promise<TPayload> {
  const { response, release } = await fetchWithTimeoutGuarded(
    params.url,
    { method: "GET", headers: params.headers },
    params.timeoutMs,
    params.fetchFn,
    buildGuardedGetOptions({ policy: params.policy, auditContext: params.auditContext }),
  );
  try {
    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw translateHeyGenHttpError(response.status, bodyText);
    }
    return (await response.json()) as TPayload;
  } finally {
    await release();
  }
}

async function pollSessionUntilVideoReady(params: {
  sessionId: string;
  mode: string;
  headers: Headers;
  deadline: ReturnType<typeof createProviderOperationDeadline>;
  baseUrl: string;
  fetchFn: typeof fetch;
  policy: HeyGenTransportPolicy;
}): Promise<{ sessionStatus: SessionStatus; videoId: string }> {
  let consecutiveThinking = 0;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const payload = await fetchHeyGenJsonGuarded<GetSessionResponse>({
      url: `${params.baseUrl}/v3/video-agents/${encodeURIComponent(params.sessionId)}`,
      headers: params.headers,
      timeoutMs: resolveProviderOperationTimeoutMs({
        deadline: params.deadline,
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      }),
      fetchFn: params.fetchFn,
      policy: params.policy,
      auditContext: "heygen-video-agent-session-poll",
    });
    const envelopeError = extractErrorMessage(payload);
    if (envelopeError) {
      throw new Error(envelopeError);
    }
    const data = payload.data;
    const status = data?.status;
    const videoId = normalizeOptionalString(data?.video_id ?? undefined);

    switch (status) {
      case "failed": {
        const message = extractErrorMessage(payload) ?? "HeyGen Video Agent session failed";
        throw new Error(message);
      }
      case "waiting_for_input":
        throw new Error(
          "HeyGen Video Agent session is waiting for input. Use mode='generate' for one-shot generation.",
        );
      case "completed":
        if (videoId) {
          return { sessionStatus: status, videoId };
        }
        throw new Error("HeyGen Video Agent session completed without a video_id.");
      default:
        if (videoId) {
          return { sessionStatus: status ?? "generating", videoId };
        }
        if (status === "thinking") {
          consecutiveThinking += 1;
          if (params.mode === "generate" && consecutiveThinking >= THINKING_FAST_FAIL_POLLS) {
            throw new Error(
              `HeyGen Video Agent session ${params.sessionId} stuck in 'thinking' after ${THINKING_FAST_FAIL_POLLS} polls in generate mode; expected a video_id. Check avatar_id/voice_id.`,
            );
          }
        } else {
          consecutiveThinking = 0;
        }
        break;
    }
    await waitProviderOperationPollInterval({
      deadline: params.deadline,
      pollIntervalMs: computePollIntervalMs(attempt),
    });
  }
  throw new Error(
    `HeyGen Video Agent session ${params.sessionId} did not produce a video within the poll window.`,
  );
}

async function pollVideoUntilCompleted(params: {
  videoId: string;
  headers: Headers;
  deadline: ReturnType<typeof createProviderOperationDeadline>;
  baseUrl: string;
  fetchFn: typeof fetch;
  policy: HeyGenTransportPolicy;
}): Promise<NonNullable<GetVideoResponse["data"]>> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    const payload = await fetchHeyGenJsonGuarded<GetVideoResponse>({
      url: `${params.baseUrl}/v3/videos/${encodeURIComponent(params.videoId)}`,
      headers: params.headers,
      timeoutMs: resolveProviderOperationTimeoutMs({
        deadline: params.deadline,
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      }),
      fetchFn: params.fetchFn,
      policy: params.policy,
      auditContext: "heygen-video-file-poll",
    });
    const envelopeError = extractErrorMessage(payload);
    if (envelopeError) {
      throw new Error(envelopeError);
    }
    const data = payload.data;
    switch (data?.status) {
      case "completed":
        return data;
      case "failed": {
        const message =
          normalizeOptionalString(data.failure_message) ||
          normalizeOptionalString(data.failure_code) ||
          extractErrorMessage(payload) ||
          "HeyGen video rendering failed";
        throw new Error(message);
      }
      default:
        await waitProviderOperationPollInterval({
          deadline: params.deadline,
          pollIntervalMs: computePollIntervalMs(attempt),
        });
        break;
    }
  }
  throw new Error(
    `HeyGen video ${params.videoId} did not finish rendering within the poll window.`,
  );
}

async function downloadHeyGenVideo(params: {
  url: string;
  timeoutMs?: number;
  fetchFn: typeof fetch;
  policy: HeyGenTransportPolicy;
}): Promise<GeneratedVideoAsset> {
  const { response, release } = await fetchWithTimeoutGuarded(
    params.url,
    { method: "GET" },
    params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    params.fetchFn,
    buildGuardedGetOptions({
      policy: params.policy,
      auditContext: "heygen-video-file-download",
    }),
  );
  try {
    await assertOkOrThrowHttpError(response, "HeyGen generated video download failed");
    const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "video/mp4";
    const arrayBuffer = await response.arrayBuffer();
    const ext = mimeType.includes("webm") ? "webm" : "mp4";
    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType,
      fileName: `video-1.${ext}`,
      metadata: { sourceUrl: params.url },
    };
  } finally {
    await release();
  }
}

export function buildHeyGenVideoGenerationProvider(): VideoGenerationProvider {
  return {
    id: "heygen",
    label: "HeyGen",
    defaultModel: DEFAULT_HEYGEN_MODEL,
    models: [DEFAULT_HEYGEN_MODEL],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "heygen",
        agentDir,
      }),
    capabilities: {
      providerOptions: {
        avatar_id: "string",
        voice_id: "string",
        style_id: "string",
        orientation: "string",
        mode: "string",
        callback_url: "string",
        callback_id: "string",
        incognito_mode: "boolean",
      },
      generate: {
        maxVideos: 1,
        maxDurationSeconds: MAX_DURATION_SECONDS,
        aspectRatios: HEYGEN_ASPECT_RATIOS,
        supportsAspectRatio: true,
        supportsAudio: false,
      },
      imageToVideo: {
        enabled: true,
        maxVideos: 1,
        maxInputImages: MAX_FILE_ATTACHMENTS,
        maxDurationSeconds: MAX_DURATION_SECONDS,
        aspectRatios: HEYGEN_ASPECT_RATIOS,
        supportsAspectRatio: true,
        supportsAudio: false,
      },
      videoToVideo: {
        enabled: false,
      },
    },
    async generateVideo(req): Promise<VideoGenerationResult> {
      if ((req.inputVideos?.length ?? 0) > 0) {
        throw new Error("HeyGen video generation does not support video reference inputs.");
      }
      const requestBody = buildCreateSessionBody(req);

      const auth = await resolveApiKeyForProvider({
        provider: "heygen",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("HeyGen API key missing");
      }

      const fetchFn = fetch;
      const deadline = createProviderOperationDeadline({
        timeoutMs: req.timeoutMs,
        label: "HeyGen Video Agent",
      });
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveHeyGenBaseUrl(req),
          defaultBaseUrl: DEFAULT_HEYGEN_BASE_URL,
          defaultHeaders: {
            "X-Api-Key": auth.apiKey,
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": HEYGEN_USER_AGENT,
            "X-HeyGen-Source": HEYGEN_PARTNER_SOURCE,
          },
          provider: "heygen",
          capability: "video",
          transport: "http",
        });

      const { response, release } = await postJsonRequest({
        url: `${baseUrl}/v3/video-agents`,
        headers,
        body: requestBody,
        timeoutMs: resolveProviderOperationTimeoutMs({
          deadline,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        }),
        fetchFn,
        allowPrivateNetwork,
        dispatcherPolicy,
      });

      try {
        if (!response.ok) {
          const bodyText = await response.text().catch(() => "");
          throw translateHeyGenHttpError(response.status, bodyText);
        }
        const submitted = (await response.json()) as CreateSessionResponse;
        if (submitted.error) {
          const message =
            extractErrorMessage(submitted) ?? "HeyGen Video Agent session create failed";
          throw new Error(message);
        }
        const sessionId = normalizeOptionalString(submitted.data?.session_id);
        if (!sessionId) {
          throw new Error("HeyGen Video Agent create response missing session_id.");
        }
        const initialStatus = submitted.data?.status;
        if (initialStatus === "failed") {
          throw new Error("HeyGen Video Agent session failed immediately after create.");
        }
        let videoId = normalizeOptionalString(submitted.data?.video_id ?? undefined);
        let sessionStatus: SessionStatus = initialStatus ?? "thinking";
        const resolvedMode = typeof requestBody.mode === "string" ? requestBody.mode : "generate";
        const transportPolicy: HeyGenTransportPolicy = {
          allowPrivateNetwork,
          dispatcherPolicy,
        };
        if (!videoId) {
          const polled = await pollSessionUntilVideoReady({
            sessionId,
            mode: resolvedMode,
            headers,
            deadline,
            baseUrl,
            fetchFn,
            policy: transportPolicy,
          });
          videoId = polled.videoId;
          sessionStatus = polled.sessionStatus;
        }
        const completed = await pollVideoUntilCompleted({
          videoId,
          headers,
          deadline,
          baseUrl,
          fetchFn,
          policy: transportPolicy,
        });
        const videoUrl = normalizeOptionalString(completed.video_url ?? undefined);
        if (!videoUrl) {
          throw new Error("HeyGen video rendering completed without a video_url.");
        }
        const video = await downloadHeyGenVideo({
          url: videoUrl,
          timeoutMs: resolveProviderOperationTimeoutMs({
            deadline,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          }),
          fetchFn,
          policy: transportPolicy,
        });
        return {
          videos: [video],
          model: normalizeOptionalString(req.model) ?? DEFAULT_HEYGEN_MODEL,
          metadata: {
            sessionId,
            videoId,
            sessionStatus,
            videoStatus: completed.status,
            videoUrl,
            thumbnailUrl: completed.thumbnail_url ?? undefined,
            duration: completed.duration ?? undefined,
          },
        };
      } finally {
        await release();
      }
    },
  };
}
