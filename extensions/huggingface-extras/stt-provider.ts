// Hugging Face speech-to-text provider.
//
// Hits the legacy hf-inference route at
// `https://router.huggingface.co/hf-inference/models/openai/whisper-large-v3`
// with raw audio bytes in the request body. The response is JSON of the
// shape `{"text": "..."}`.
//
// Hugging Face does NOT expose an OpenAI-compatible
// `POST /v1/audio/transcriptions` endpoint on this route, so we cannot reuse
// `transcribeOpenAiCompatibleAudio` from the SDK helper. We register a
// dedicated `MediaUnderstandingProvider` whose `transcribeAudio` method
// performs the raw POST itself.

import {
  HUGGINGFACE_INFERENCE_BASE_URL,
  PROVIDER_ID,
  type AudioTranscriptionRequest,
  type AudioTranscriptionResult,
  type MediaUnderstandingProvider,
} from "./api.js";

const DEFAULT_STT_MODEL = "openai/whisper-large-v3";

type WhisperResponse = {
  text?: string;
  error?: string | { message?: string };
};

function describeError(status: number, body: WhisperResponse | string): string {
  if (typeof body === "string") {
    return body || `huggingface-extras STT request failed with status ${status}`;
  }
  if (body.error) {
    if (typeof body.error === "string") {
      return body.error;
    }
    if (typeof body.error.message === "string") {
      return body.error.message;
    }
  }
  return `huggingface-extras STT request failed with status ${status}`;
}

function buildModelEndpoint(modelId: string): string {
  const safeId = modelId.trim().replace(/^\/+|\/+$/gu, "");
  if (!safeId) {
    throw new Error("huggingface-extras STT: model id is empty");
  }
  return `${HUGGINGFACE_INFERENCE_BASE_URL}/models/${safeId}`;
}

async function transcribeAudio(req: AudioTranscriptionRequest): Promise<AudioTranscriptionResult> {
  const modelId = req.model?.trim() || DEFAULT_STT_MODEL;
  const endpoint = buildModelEndpoint(modelId);
  const apiKey = req.apiKey;
  if (!apiKey) {
    throw new Error("huggingface-extras STT: HF API key not provided in transcription request");
  }

  const controller = new AbortController();
  const timer =
    typeof req.timeoutMs === "number" && req.timeoutMs > 0
      ? setTimeout(() => controller.abort(), req.timeoutMs)
      : undefined;
  const fetchFn = req.fetchFn ?? fetch;
  try {
    const bytes = new Uint8Array(req.buffer);
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": req.mime || "application/octet-stream",
        Accept: "application/json",
        ...req.headers,
      },
      body: bytes,
      signal: controller.signal,
    });

    const text = await response.text().catch(() => "");
    let body: WhisperResponse | string;
    try {
      body = JSON.parse(text) as WhisperResponse;
    } catch {
      body = text;
    }

    if (!response.ok) {
      throw new Error(describeError(response.status, body));
    }
    if (typeof body === "string" || typeof body.text !== "string") {
      throw new Error("huggingface-extras STT response is missing `text` field");
    }
    return {
      text: body.text,
      model: modelId,
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export const huggingFaceExtrasMediaUnderstandingProvider: MediaUnderstandingProvider = {
  id: PROVIDER_ID,
  capabilities: ["audio"],
  defaultModels: {
    audio: DEFAULT_STT_MODEL,
  },
  transcribeAudio,
};
