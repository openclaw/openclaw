import type {
  AudioTranscriptionConfigContext,
  MediaUnderstandingProvider,
} from "openclaw/plugin-sdk/media-understanding";
import { transcribeOpenAiCompatibleAudio } from "openclaw/plugin-sdk/media-understanding";
import {
  ensureAuthProfileStoreAsync,
  listProfilesForProvider,
} from "openclaw/plugin-sdk/provider-auth";
import { requireApiKey, resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { omitNullRequestHeaders } from "openclaw/plugin-sdk/provider-request-headers";
import { fetchWithRuntimeDispatcher } from "openclaw/plugin-sdk/runtime-fetch";
import { normalizeClawRouterRootUrl } from "./base-url.js";
import {
  fetchClawRouterCapabilityOffers,
  resolveClawRouterCapabilityHttpContext,
} from "./capability-offers.js";

const MODEL = "gpt-4o-transcribe";
const SENSEAUDIO_MODEL = "senseaudio-asr-pro-1.5-260319";
const SENSEAUDIO_UPLOAD_MIMES: Record<string, readonly string[]> = {
  wav: ["audio/wav", "audio/wave", "audio/x-wav"],
  mp3: ["audio/mpeg", "audio/mp3"],
  ogg: ["audio/ogg", "application/ogg"],
  flac: ["audio/flac", "audio/x-flac"],
  aac: ["audio/aac"],
  m4a: ["audio/mp4", "audio/x-m4a"],
  mp4: ["audio/mp4", "video/mp4"],
};

async function prepare(context: AudioTranscriptionConfigContext & { signal?: AbortSignal }) {
  context.signal?.throwIfAborted();
  const model = context.model ?? MODEL;
  const senseaudio = model === "senseaudio/" + SENSEAUDIO_MODEL;
  if (!senseaudio && model !== MODEL && model !== "openai/" + MODEL) {
    throw new Error("ClawRouter transcription requires a qualified OpenAI or SenseAudio model");
  }
  const provider = senseaudio ? "senseaudio" : "openai";
  const upstreamModel = senseaudio ? SENSEAUDIO_MODEL : MODEL;
  const configured = context.cfg.models?.providers?.clawrouter;
  // These overrides would replace the credential selected by the canonical auth owner.
  if (
    [context.request?.auth, configured?.request?.auth].some(
      (auth) => auth && auth.mode !== "provider-default",
    )
  ) {
    throw new Error("ClawRouter transcription requires provider-default request auth");
  }
  for (const name of [
    ...Object.keys(context.headers ?? {}),
    ...Object.keys(context.request?.headers ?? {}),
    ...Object.keys(configured?.headers ?? {}),
    ...Object.keys(configured?.request?.headers ?? {}),
  ]) {
    if (
      [
        "authorization",
        "x-api-key",
        "api-key",
        "cookie",
        "content-type",
        "content-length",
      ].includes(name.toLowerCase())
    ) {
      throw new Error(
        "ClawRouter transcription does not accept credential or multipart framing header overrides",
      );
    }
  }
  const configuredBaseUrl = context.baseUrl ?? context.cfg.models?.providers?.clawrouter?.baseUrl;
  const normalized = normalizeClawRouterRootUrl(configuredBaseUrl);
  const nativeSuffix = `/v1/native/${provider}`;
  const rootUrl = normalized.endsWith(nativeSuffix)
    ? normalized.slice(0, -nativeSuffix.length)
    : normalized;
  // Bare configured model identities belong to the native OpenAI route, not the unified route.
  const baseUrl = `${rootUrl}/v1/native/${provider}/v1`;
  let store;
  if (context.profile) {
    store = await ensureAuthProfileStoreAsync(context.agentDir, {
      config: context.cfg,
      readOnly: true,
      allowKeychainPrompt: false,
    });
    // A locked identity alone does not establish that its credential belongs to this provider.
    if (!listProfilesForProvider(store, "clawrouter").includes(context.profile)) {
      throw new Error("Selected transcription auth profile is unavailable for ClawRouter");
    }
  }
  const auth = await resolveApiKeyForProvider({
    provider: "clawrouter",
    cfg: context.cfg,
    agentDir: context.agentDir,
    workspaceDir: context.workspaceDir,
    store,
    profileId: context.profile,
    preferredProfile: context.preferredProfile,
    lockedProfile: Boolean(context.profile),
    modelId: model,
    modelBaseUrl: baseUrl,
    capability: "audio-transcription",
    signal: context.signal,
  });
  context.signal?.throwIfAborted();
  if (auth.profileId) {
    store ??= await ensureAuthProfileStoreAsync(context.agentDir, {
      config: context.cfg,
      readOnly: true,
      allowKeychainPrompt: false,
    });
    if (!listProfilesForProvider(store, "clawrouter").includes(auth.profileId)) {
      throw new Error("Resolved transcription credential does not belong to ClawRouter");
    }
  }
  if (auth.mode !== "api-key") {
    throw new Error("ClawRouter transcription requires a ClawRouter API key");
  }
  return {
    model,
    provider,
    upstreamModel,
    rootUrl,
    baseUrl,
    apiKey: requireApiKey(auth, "clawrouter"),
    source: auth.source,
  };
}

export const clawrouterMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: "clawrouter",
  capabilities: ["audio"],
  inheritConfiguredImageCapability: true,
  sharedEntryCapabilities: ["image"],
  defaultModels: { audio: MODEL },
  // Active/configured providers are automatically eligible; readiness is not a model grant or admission proof.
  async isAudioConfigured(context) {
    try {
      await prepare(context);
      return true;
    } catch {
      return false;
    }
  },
  async transcribeAudioWithContext(context) {
    let uploadStarted = false;
    try {
      const remaining = createProviderOperationTimeoutResolver({
        deadline: createProviderOperationDeadline({
          timeoutMs: context.timeoutMs,
          label: "ClawRouter transcription",
        }),
        defaultTimeoutMs: context.timeoutMs,
      });
      const prepared = await prepare(context);
      const senseaudio = prepared.provider === "senseaudio";
      if (context.query && Object.keys(context.query).length > 0) {
        throw new Error(
          "ClawRouter transcription does not support providerOptions; use language and prompt only",
        );
      }
      const maxBytes = senseaudio ? 10_000_000 : 25_000_000;
      if (context.buffer.length === 0 || context.buffer.length > maxBytes) {
        throw new Error(`ClawRouter transcription requires 1-${maxBytes} file bytes`);
      }
      // The shared helper normalizes paths/AAC names; reject unsupported names rather than silently relabeling bytes.
      if (
        !/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,126}$/.test(context.fileName) ||
        context.fileName.includes("..") ||
        context.fileName !== context.fileName.trim() ||
        (!senseaudio && (/\.aac$/i.test(context.fileName) || context.mime === "audio/aac"))
      ) {
        throw new Error(
          "ClawRouter transcription requires a safe upload filename (AAC relabeling is unsupported)",
        );
      }
      if (
        senseaudio &&
        ((context.language?.trim() && !/^[a-z]{2,3}$/u.test(context.language.trim())) ||
          Buffer.byteLength(context.prompt ?? "", "utf8") > 16384)
      ) {
        throw new Error(
          "ClawRouter SenseAudio requires ISO-639 language and a prompt within 16 KiB",
        );
      }
      if (senseaudio) {
        const formats =
          SENSEAUDIO_UPLOAD_MIMES[context.fileName.split(".").at(-1)?.toLowerCase() ?? ""];
        const mime = context.mime?.trim().toLowerCase() || "application/octet-stream";
        if (!formats || (mime !== "application/octet-stream" && !formats.includes(mime))) {
          throw new Error("ClawRouter SenseAudio filename and MIME are unsupported");
        }
      }
      const configured = context.cfg.models?.providers?.clawrouter;
      const configuredRequest = sanitizeConfiguredModelProviderRequest(configured?.request);
      const http = resolveClawRouterCapabilityHttpContext(
        {
          ...context.cfg,
          models: {
            ...context.cfg.models,
            providers: {
              ...context.cfg.models?.providers,
              clawrouter: {
                ...configured,
                baseUrl: prepared.rootUrl,
                models: configured?.models ?? [],
                headers: context.headers ?? configured?.headers,
                request: {
                  ...configuredRequest,
                  ...context.request,
                  headers: omitNullRequestHeaders({
                    ...configuredRequest?.headers,
                    ...context.request?.headers,
                  }),
                },
              },
            },
          },
        },
        prepared.apiKey,
        "audio",
      );
      const offers = await fetchClawRouterCapabilityOffers({
        context: http,
        timeoutMs: remaining,
        signal: context.signal,
        requireFreshProxyCatalog: true,
      });
      const offer = offers.find(
        (candidate) =>
          candidate.providerId === prepared.provider &&
          candidate.endpoint === "transcriptions" &&
          candidate.path === "/v1/audio/transcriptions" &&
          candidate.routeKind === "native" &&
          candidate.methods.includes("POST") &&
          candidate.requestFormat === "openai.audio_transcriptions" &&
          candidate.responseFormat ===
            (senseaudio ? "senseaudio.transcription" : "openai.audio_transcriptions") &&
          candidate.model?.id === `${prepared.provider}/${prepared.upstreamModel}` &&
          candidate.model.upstream === prepared.upstreamModel &&
          Array.isArray(candidate.model.capabilities) &&
          candidate.model.capabilities.includes("audio.transcription"),
      );
      if (!offer) {
        throw new Error("ClawRouter transcription has no eligible supported catalog offer");
      }
      context.signal?.throwIfAborted();
      const value = await transcribeOpenAiCompatibleAudio({
        ...context,
        ...prepared,
        model: prepared.upstreamModel,
        baseUrl: offer.url.slice(0, -"/audio/transcriptions".length),
        timeoutMs: remaining(),
        preserveAacFileName: senseaudio,
        provider: "clawrouter",
        defaultModel: prepared.upstreamModel,
        defaultBaseUrl: prepared.baseUrl,
        auth: { kind: "api-key", apiKey: prepared.apiKey, source: prepared.source },
        // Keep the guard's dispatcher (native Bun fetch ignores it), but never replay this upload on redirect.
        fetchFn: (input, init) => {
          uploadStarted = true;
          return (context.fetchFn ?? fetchWithRuntimeDispatcher)(input, {
            ...init,
            redirect: "error",
          });
        },
      });
      return { ok: true, value: { ...value, model: prepared.model } };
    } catch (error) {
      // The shared guard may reject configuration or network policy before calling fetchFn.
      // After dispatch, even an HTTP or transport failure must not disclose to another provider.
      if (uploadStarted) {
        throw error;
      }
      return { ok: false, error };
    }
  },
};
