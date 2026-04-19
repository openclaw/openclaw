import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
} from "openclaw/plugin-sdk/media-understanding";
import {
  assertOkOrThrowHttpError,
  postTranscriptionRequest,
  resolveProviderHttpRequestConfig,
  requireTranscriptionText,
} from "openclaw/plugin-sdk/provider-http";

export const DEFAULT_SPEECH_HANDS_BASE_URL = "http://localhost:8080";
export const DEFAULT_SPEECH_HANDS_MODEL = "speech-hands-qwen2.5-omni-7b";

function resolveModel(model?: string): string {
  return model?.trim() || DEFAULT_SPEECH_HANDS_MODEL;
}

type SpeechHandsActionToken = "<internal>" | "<external>" | "<rewrite>";

type SpeechHandsTranscribeResponse = {
  text?: string;
  model?: string;
  action_token?: SpeechHandsActionToken;
  internal_pred?: string;
  external_pred?: string;
  routing_confidence?: number;
};

export async function transcribeSpeechHandsAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const model = resolveModel(params.model);
  const defaultHeaders: Record<string, string> = {
    "content-type": "application/json",
  };
  const trimmedApiKey = params.apiKey?.trim();
  if (trimmedApiKey) {
    defaultHeaders.authorization = `Bearer ${trimmedApiKey}`;
  }
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: params.baseUrl,
      defaultBaseUrl: DEFAULT_SPEECH_HANDS_BASE_URL,
      headers: params.headers,
      request: params.request,
      defaultHeaders,
      provider: "speech-hands",
      capability: "audio",
      transport: "media-understanding",
    });

  const body = JSON.stringify({
    audio: Buffer.from(params.buffer).toString("base64"),
    file_name: params.fileName,
    mime: params.mime,
    model,
    language: params.language?.trim() || undefined,
  });

  const url = new URL("/v1/transcribe", baseUrl).toString();
  const { response: res, release } = await postTranscriptionRequest({
    url,
    headers,
    body,
    timeoutMs: params.timeoutMs,
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
  });

  try {
    await assertOkOrThrowHttpError(res, "Speech-Hands transcription failed");
    const payload = (await res.json()) as SpeechHandsTranscribeResponse;
    const text = requireTranscriptionText(
      payload.text,
      "Speech-Hands response missing `text` field",
    );
    return { text, model: payload.model ?? model };
  } finally {
    await release();
  }
}
