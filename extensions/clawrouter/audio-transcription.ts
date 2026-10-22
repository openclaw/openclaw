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
import { fetchWithRuntimeDispatcher } from "openclaw/plugin-sdk/runtime-fetch";
import { normalizeClawRouterRootUrl } from "./base-url.js";

const MODEL = "gpt-4o-transcribe";

async function prepare(context: AudioTranscriptionConfigContext & { signal?: AbortSignal }) {
  context.signal?.throwIfAborted();
  const model = context.model ?? MODEL;
  if (model !== MODEL && model !== "openai/" + MODEL) {
    throw new Error("ClawRouter transcription supports only gpt-4o-transcribe");
  }
  // These overrides would replace the credential selected by the canonical auth owner.
  if (context.request?.auth && context.request.auth.mode !== "provider-default") {
    throw new Error("ClawRouter transcription requires provider-default request auth");
  }
  for (const name of [
    ...Object.keys(context.headers ?? {}),
    ...Object.keys(context.request?.headers ?? {}),
  ]) {
    if (
      ["authorization", "x-api-key", "cookie", "content-type", "content-length"].includes(
        name.toLowerCase(),
      )
    ) {
      throw new Error(
        "ClawRouter transcription does not accept credential or multipart framing header overrides",
      );
    }
  }
  const configuredBaseUrl = context.baseUrl ?? context.cfg.models?.providers?.clawrouter?.baseUrl;
  const rootUrl = normalizeClawRouterRootUrl(configuredBaseUrl);
  // Bare configured model identities belong to the native OpenAI route, not the unified route.
  const baseUrl = rootUrl.endsWith("/v1/native/openai")
    ? `${rootUrl}/v1`
    : `${rootUrl}/v1/native/openai/v1`;
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
  return { model, baseUrl, apiKey: requireApiKey(auth, "clawrouter"), source: auth.source };
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
      const prepared = await prepare(context);
      if (context.query && Object.keys(context.query).length > 0) {
        throw new Error(
          "ClawRouter transcription does not support providerOptions; use language and prompt only",
        );
      }
      if (context.buffer.length === 0 || context.buffer.length > 25_000_000) {
        throw new Error("ClawRouter transcription requires 1-25000000 file bytes");
      }
      // The shared helper normalizes paths/AAC names; reject unsupported names rather than silently relabeling bytes.
      if (
        !/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,126}$/.test(context.fileName) ||
        context.fileName.includes("..") ||
        context.fileName !== context.fileName.trim() ||
        /\.aac$/i.test(context.fileName) ||
        context.mime === "audio/aac"
      ) {
        throw new Error(
          "ClawRouter transcription requires a safe upload filename (AAC relabeling is unsupported)",
        );
      }
      return {
        ok: true,
        value: await transcribeOpenAiCompatibleAudio({
          ...context,
          ...prepared,
          provider: "clawrouter",
          defaultModel: MODEL,
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
        }),
      };
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
