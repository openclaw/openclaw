import {
  asObject,
  readResponseTextLimited,
  trimToUndefined,
  truncateErrorDetail,
} from "openclaw/plugin-sdk/speech";

export const DEFAULT_MINIMAX_TTS_BASE_URL = "https://api.minimax.io/v1";

export const MINIMAX_TTS_MODELS = [
  "speech-2.8-hd",
  "speech-2.8-turbo",
  "speech-2.6-hd",
  "speech-2.6-turbo",
  "speech-02-hd",
  "speech-02-turbo",
  "speech-01-hd",
  "speech-01-turbo",
] as const;

export const MINIMAX_TTS_VOICES = [
  "English_expressive_narrator",
  "English_Graceful_Lady",
  "English_Insightful_Speaker",
  "English_radiant_girl",
  "English_Persuasive_Man",
  "English_Lucky_Robot",
] as const;

export const MINIMAX_TTS_EMOTIONS = [
  "happy",
  "sad",
  "angry",
  "fearful",
  "disgusted",
  "surprised",
  "calm",
  "fluent",
  "whisper",
] as const;

export function normalizeMinimaxTtsBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  return trimmed?.replace(/\/+$/, "") || DEFAULT_MINIMAX_TTS_BASE_URL;
}

function formatMinimaxErrorPayload(payload: unknown): string | undefined {
  const root = asObject(payload);
  const baseResp = asObject(root?.base_resp);
  if (!baseResp) {
    return undefined;
  }
  const statusCode = baseResp.status_code;
  const statusMsg = trimToUndefined(baseResp.status_msg);
  if (typeof statusCode === "number" && statusCode !== 0) {
    return statusMsg
      ? `${truncateErrorDetail(statusMsg)} [status_code=${statusCode}]`
      : `[status_code=${statusCode}]`;
  }
  if (statusMsg) {
    return truncateErrorDetail(statusMsg);
  }
  return undefined;
}

async function extractMinimaxErrorDetail(response: Response): Promise<string | undefined> {
  const rawBody = trimToUndefined(await readResponseTextLimited(response));
  if (!rawBody) {
    return undefined;
  }
  try {
    return formatMinimaxErrorPayload(JSON.parse(rawBody)) ?? truncateErrorDetail(rawBody);
  } catch {
    return truncateErrorDetail(rawBody);
  }
}

type MinimaxTtsResponse = {
  data?: {
    audio?: string;
    status?: number;
  };
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
  extra_info?: {
    audio_format?: string;
    audio_sample_rate?: number;
  };
  trace_id?: string;
};

export async function minimaxTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  voiceId: string;
  speed: number;
  vol: number;
  pitch: number;
  emotion?: string;
  languageBoost?: string;
  sampleRate?: number;
  bitrate?: number;
  audioFormat?: "mp3" | "pcm" | "flac";
  timeoutMs: number;
}): Promise<Buffer> {
  const {
    text,
    apiKey,
    baseUrl,
    model,
    voiceId,
    speed,
    vol,
    pitch,
    emotion,
    languageBoost,
    sampleRate,
    bitrate,
    audioFormat,
    timeoutMs,
  } = params;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body: Record<string, unknown> = {
      model,
      text,
      stream: false,
      output_format: "hex",
      voice_setting: {
        voice_id: voiceId,
        speed: Math.trunc(speed),
        vol: Math.trunc(vol),
        pitch: Math.trunc(pitch),
      },
    };

    if (languageBoost) {
      body.language_boost = languageBoost;
    }

    if (emotion) {
      (body.voice_setting as Record<string, unknown>).emotion = emotion;
    }

    if (sampleRate != null || bitrate != null || audioFormat != null) {
      const audioSetting: Record<string, unknown> = {};
      if (sampleRate != null) audioSetting.sample_rate = sampleRate;
      if (bitrate != null) audioSetting.bitrate = bitrate;
      if (audioFormat != null) audioSetting.format = audioFormat;
      body.audio_setting = audioSetting;
    }

    const response = await fetch(`${baseUrl}/t2a_v2`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await extractMinimaxErrorDetail(response);
      throw new Error(`MiniMax TTS API error (${response.status})` + (detail ? `: ${detail}` : ""));
    }

    const json = (await response.json()) as MinimaxTtsResponse;

    if (json.base_resp?.status_code && json.base_resp.status_code !== 0) {
      const detail = formatMinimaxErrorPayload(json);
      throw new Error(
        `MiniMax TTS API error` +
          (detail ? `: ${detail}` : `: status_code=${json.base_resp.status_code}`),
      );
    }

    const hexAudio = json.data?.audio;
    if (!hexAudio) {
      throw new Error("MiniMax TTS API returned no audio data");
    }

    return Buffer.from(hexAudio, "hex");
  } finally {
    clearTimeout(timeout);
  }
}
