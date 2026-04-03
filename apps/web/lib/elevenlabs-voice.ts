import {
  buildDenchGatewayApiBaseUrl,
  normalizeDenchGatewayUrl,
} from "../../../src/cli/dench-cloud";

const DEFAULT_TTS_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_STT_MODEL_ID = "scribe_v2";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";

type UnknownRecord = Record<string, unknown>;

export type ElevenLabsVoice = {
  voiceId: string;
  name: string;
  description: string | null;
  category: string | null;
  previewUrl: string | null;
  labels: string[];
};

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildAuthHeaders(apiKey: string): HeadersInit {
  return {
    "xi-api-key": apiKey,
    Authorization: `Bearer ${apiKey}`,
  };
}

async function readUpstreamError(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const payload = await response.json().catch(() => null);
    const record = asRecord(payload);
    const detail = record?.detail;
    if (typeof detail === "string" && detail.trim()) {
      return detail.trim();
    }
    if (Array.isArray(detail) && detail.length > 0) {
      const firstDetail = asRecord(detail[0]);
      const message = readString(firstDetail?.msg) ?? readString(firstDetail?.message);
      if (message) {
        return message;
      }
    }
    return readString(record?.error) ?? readString(record?.message) ?? `Request failed (${response.status}).`;
  }
  const text = await response.text().catch(() => "");
  return text.trim() || `Request failed (${response.status}).`;
}

export function extractElevenLabsVoices(payload: unknown): ElevenLabsVoice[] {
  const root = asRecord(payload);
  const voices = Array.isArray(root?.voices)
    ? root.voices
    : Array.isArray(root?.items)
      ? root.items
      : [];

  return voices
    .map((voice) => {
      const record = asRecord(voice);
      const voiceId = readString(record?.voice_id) ?? readString(record?.voiceId);
      const name = readString(record?.name);
      if (!voiceId || !name) {
        return null;
      }
      const labels = asRecord(record?.labels);
      return {
        voiceId,
        name,
        description: readString(record?.description),
        category: readString(record?.category),
        previewUrl: readString(record?.preview_url) ?? readString(record?.previewUrl),
        labels: labels
          ? Object.values(labels)
            .map((value) => readString(value))
            .filter((value): value is string => Boolean(value))
          : [],
      };
    })
    .filter((voice): voice is ElevenLabsVoice => voice !== null);
}

export async function fetchElevenLabsVoices(params: {
  gatewayUrl: string;
  apiKey: string;
}): Promise<ElevenLabsVoice[]> {
  const rootGatewayUrl = normalizeDenchGatewayUrl(params.gatewayUrl);
  const response = await fetch(
    `${rootGatewayUrl}/v2/voices?page_size=100&include_total_count=false`,
    {
      headers: buildAuthHeaders(params.apiKey),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(await readUpstreamError(response));
  }

  return extractElevenLabsVoices(await response.json());
}

export async function resolveElevenLabsVoiceId(params: {
  gatewayUrl: string;
  apiKey: string;
  requestedVoiceId?: string | null;
  storedVoiceId?: string | null;
}): Promise<string | null> {
  const requestedVoiceId = params.requestedVoiceId?.trim() || null;
  if (requestedVoiceId) {
    return requestedVoiceId;
  }
  const storedVoiceId = params.storedVoiceId?.trim() || null;
  if (storedVoiceId) {
    return storedVoiceId;
  }
  const voices = await fetchElevenLabsVoices({
    gatewayUrl: params.gatewayUrl,
    apiKey: params.apiKey,
  });
  return voices[0]?.voiceId ?? null;
}

export async function synthesizeElevenLabsSpeech(params: {
  gatewayUrl: string;
  apiKey: string;
  text: string;
  voiceId: string;
}): Promise<{ audio: ArrayBuffer; contentType: string }> {
  const apiBaseUrl = buildDenchGatewayApiBaseUrl(params.gatewayUrl);
  const response = await fetch(
    `${apiBaseUrl}/text-to-speech/${encodeURIComponent(params.voiceId)}?output_format=${DEFAULT_OUTPUT_FORMAT}`,
    {
      method: "POST",
      headers: {
        ...buildAuthHeaders(params.apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: params.text,
        model_id: DEFAULT_TTS_MODEL_ID,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(await readUpstreamError(response));
  }

  return {
    audio: await response.arrayBuffer(),
    contentType: response.headers.get("content-type") ?? "audio/mpeg",
  };
}

function extractTranscriptText(payload: unknown): string {
  const record = asRecord(payload);
  const directText = readString(record?.text) ?? readString(record?.transcript);
  if (directText) {
    return directText;
  }

  const transcripts = Array.isArray(record?.transcripts) ? record.transcripts : [];
  const text = transcripts
    .map((entry) => {
      const transcript = asRecord(entry);
      return readString(transcript?.text);
    })
    .filter((entry): entry is string => Boolean(entry))
    .join("\n")
    .trim();

  return text;
}

export async function transcribeElevenLabsAudio(params: {
  gatewayUrl: string;
  apiKey: string;
  file: File;
}): Promise<{ text: string }> {
  const apiBaseUrl = buildDenchGatewayApiBaseUrl(params.gatewayUrl);
  const body = new FormData();
  body.set("model_id", DEFAULT_STT_MODEL_ID);
  body.set("file", params.file);

  const response = await fetch(`${apiBaseUrl}/speech-to-text`, {
    method: "POST",
    headers: buildAuthHeaders(params.apiKey),
    body,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      readString(asRecord(payload)?.detail)
      ?? readString(asRecord(payload)?.error)
      ?? readString(asRecord(payload)?.message)
      ?? `Request failed (${response.status}).`,
    );
  }

  const text = extractTranscriptText(payload);
  if (!text) {
    throw new Error("Transcription completed without any text.");
  }

  return { text };
}
