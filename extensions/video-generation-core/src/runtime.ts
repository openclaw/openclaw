import {
  createSubsystemLogger,
  describeFailoverError,
  getProviderEnvVars,
  getVideoGenerationProvider,
  isFailoverError,
  listVideoGenerationProviders,
  parseVideoGenerationModelRef,
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
  type AuthProfileStore,
  type FallbackAttempt,
  type GeneratedVideoAsset,
  type OpenClawConfig,
  type VideoGenerationIgnoredOverride,
  type VideoGenerationResolution,
  type VideoGenerationResult,
  type VideoGenerationSourceAsset,
} from "../api.js";

const log = createSubsystemLogger("video-generation");

export type GenerateVideoParams = {
  cfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  modelOverride?: string;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
  inputImages?: VideoGenerationSourceAsset[];
  inputVideos?: VideoGenerationSourceAsset[];
};

export type GenerateVideoRuntimeResult = {
  videos: GeneratedVideoAsset[];
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  metadata?: Record<string, unknown>;
  ignoredOverrides: VideoGenerationIgnoredOverride[];
};

function resolveVideoGenerationCandidates(params: {
  cfg: OpenClawConfig;
  modelOverride?: string;
}): Array<{ provider: string; model: string }> {
  const candidates: Array<{ provider: string; model: string }> = [];
  const seen = new Set<string>();
  const add = (raw: string | undefined) => {
    const parsed = parseVideoGenerationModelRef(raw);
    if (!parsed) {
      return;
    }
    const key = `${parsed.provider}/${parsed.model}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(parsed);
  };

  add(params.modelOverride);
  add(resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.videoGenerationModel));
  for (const fallback of resolveAgentModelFallbackValues(
    params.cfg.agents?.defaults?.videoGenerationModel,
  )) {
    add(fallback);
  }
  return candidates;
}

function throwVideoGenerationFailure(params: {
  attempts: FallbackAttempt[];
  lastError: unknown;
}): never {
  if (params.attempts.length <= 1 && params.lastError) {
    throw params.lastError;
  }
  const summary =
    params.attempts.length > 0
      ? params.attempts
          .map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`)
          .join(" | ")
      : "unknown";
  throw new Error(`All video generation models failed (${params.attempts.length}): ${summary}`, {
    cause: params.lastError instanceof Error ? params.lastError : undefined,
  });
}

function buildNoVideoGenerationModelConfiguredMessage(cfg: OpenClawConfig): string {
  const providers = listVideoGenerationProviders(cfg);
  const sampleModel =
    providers.find((provider) => provider.defaultModel) ??
    ({ id: "qwen", defaultModel: "wan2.6-t2v" } as const);
  const authHints = providers
    .flatMap((provider) => {
      const envVars = getProviderEnvVars(provider.id);
      if (envVars.length === 0) {
        return [];
      }
      return [`${provider.id}: ${envVars.join(" / ")}`];
    })
    .slice(0, 3);
  return [
    `No video-generation model configured. Set agents.defaults.videoGenerationModel.primary to a provider/model like "${sampleModel.id}/${sampleModel.defaultModel}".`,
    authHints.length > 0
      ? `If you want a specific provider, also configure that provider's auth/API key first (${authHints.join("; ")}).`
      : "If you want a specific provider, also configure that provider's auth/API key first.",
  ].join(" ");
}

export function listRuntimeVideoGenerationProviders(params?: { config?: OpenClawConfig }) {
  return listVideoGenerationProviders(params?.config);
}

function resolveProviderVideoGenerationOverrides(params: {
  provider: NonNullable<ReturnType<typeof getVideoGenerationProvider>>;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  audio?: boolean;
  watermark?: boolean;
}) {
  const caps = params.provider.capabilities;
  const ignoredOverrides: VideoGenerationIgnoredOverride[] = [];
  let size = params.size;
  let aspectRatio = params.aspectRatio;
  let resolution = params.resolution;
  let audio = params.audio;
  let watermark = params.watermark;

  if (size && !caps.supportsSize) {
    ignoredOverrides.push({ key: "size", value: size });
    size = undefined;
  }

  if (aspectRatio && !caps.supportsAspectRatio) {
    ignoredOverrides.push({ key: "aspectRatio", value: aspectRatio });
    aspectRatio = undefined;
  }

  if (resolution && !caps.supportsResolution) {
    ignoredOverrides.push({ key: "resolution", value: resolution });
    resolution = undefined;
  }

  if (typeof audio === "boolean" && !caps.supportsAudio) {
    ignoredOverrides.push({ key: "audio", value: audio });
    audio = undefined;
  }

  if (typeof watermark === "boolean" && !caps.supportsWatermark) {
    ignoredOverrides.push({ key: "watermark", value: watermark });
    watermark = undefined;
  }

  return {
    size,
    aspectRatio,
    resolution,
    audio,
    watermark,
    ignoredOverrides,
  };
}

export async function generateVideo(
  params: GenerateVideoParams,
): Promise<GenerateVideoRuntimeResult> {
  const candidates = resolveVideoGenerationCandidates({
    cfg: params.cfg,
    modelOverride: params.modelOverride,
  });
  if (candidates.length === 0) {
    throw new Error(buildNoVideoGenerationModelConfiguredMessage(params.cfg));
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (const candidate of candidates) {
    const provider = getVideoGenerationProvider(candidate.provider, params.cfg);
    if (!provider) {
      const error = `No video-generation provider registered for ${candidate.provider}`;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error,
      });
      lastError = new Error(error);
      continue;
    }

    try {
      const sanitized = resolveProviderVideoGenerationOverrides({
        provider,
        size: params.size,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        audio: params.audio,
        watermark: params.watermark,
      });
      const result: VideoGenerationResult = await provider.generateVideo({
        provider: candidate.provider,
        model: candidate.model,
        prompt: params.prompt,
        cfg: params.cfg,
        agentDir: params.agentDir,
        authStore: params.authStore,
        size: sanitized.size,
        aspectRatio: sanitized.aspectRatio,
        resolution: sanitized.resolution,
        durationSeconds: params.durationSeconds,
        audio: sanitized.audio,
        watermark: sanitized.watermark,
        inputImages: params.inputImages,
        inputVideos: params.inputVideos,
      });
      if (!Array.isArray(result.videos) || result.videos.length === 0) {
        throw new Error("Video generation provider returned no videos.");
      }
      return {
        videos: result.videos,
        provider: candidate.provider,
        model: result.model ?? candidate.model,
        attempts,
        ignoredOverrides: sanitized.ignoredOverrides,
        metadata: result.metadata,
      };
    } catch (err) {
      lastError = err;
      const described = isFailoverError(err) ? describeFailoverError(err) : undefined;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: described?.message ?? (err instanceof Error ? err.message : String(err)),
        reason: described?.reason,
        status: described?.status,
        code: described?.code,
      });
      log.debug(`video-generation candidate failed: ${candidate.provider}/${candidate.model}`);
    }
  }

  throwVideoGenerationFailure({ attempts, lastError });
}
