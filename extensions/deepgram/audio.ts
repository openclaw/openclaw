import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
} from "openclaw/plugin-sdk/media-understanding";

export const DEFAULT_DEEPGRAM_AUDIO_BASE_URL = "https://api.deepgram.com/v1";
export const DEFAULT_DEEPGRAM_AUDIO_MODEL = "nova-3";

export async function transcribeDeepgramAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const { resolveProviderHttpRequestConfigWithOriginTrust } =
    await import("openclaw/plugin-sdk/provider-http");
  const { isDeepgramFluxModel, transcribeDeepgramFluxAudio } = await import("./audio-flux.js");
  const model = params.model?.trim() || DEFAULT_DEEPGRAM_AUDIO_MODEL;
  const flux = isDeepgramFluxModel(model);
  const requestConfig = resolveProviderHttpRequestConfigWithOriginTrust({
    baseUrl: params.baseUrl,
    defaultBaseUrl: DEFAULT_DEEPGRAM_AUDIO_BASE_URL,
    headers: params.headers,
    request: params.request,
    defaultHeaders: {
      authorization: `Token ${params.apiKey}`,
      ...(flux ? {} : { "content-type": params.mime ?? "application/octet-stream" }),
    },
    provider: "deepgram",
    capability: "audio",
    transport: "media-understanding",
  });
  if (flux) {
    return await transcribeDeepgramFluxAudio({ request: params, requestConfig, model });
  }
  const { transcribeDeepgramPrerecordedAudio } =
    await import("openclaw/plugin-sdk/media-understanding");
  return transcribeDeepgramPrerecordedAudio({ request: params, requestConfig, model });
}
