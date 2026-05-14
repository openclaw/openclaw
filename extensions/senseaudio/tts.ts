import { assertOkOrThrowProviderError } from "openclaw/plugin-sdk/provider-http";
import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech-core";
import { trimToUndefined } from "openclaw/plugin-sdk/speech-core";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "openclaw/plugin-sdk/ssrf-runtime";

export const DEFAULT_SENSEAUDIO_TTS_BASE_URL = "https://api.senseaudio.cn";
export const DEFAULT_SENSEAUDIO_TTS_MODEL = "senseaudio-tts-1.5-260319";
export const DEFAULT_SENSEAUDIO_TTS_VOICE = "female_0033_b";

const TTS_AUDIO_SAMPLE_RATE = 32_000;
const TTS_AUDIO_BITRATE = 128_000;
const TTS_AUDIO_FORMAT = "mp3";
const TTS_AUDIO_CHANNELS = 2;

type SenseAudioBaseResp = {
  status_code?: number;
  status_msg?: string;
};

type SenseAudioTtsResponse = {
  data?: { audio?: string };
  base_resp?: SenseAudioBaseResp;
};

type SenseAudioVoiceEntry = {
  voice_id?: string;
  voice_name?: string;
  description?: string[];
  created_time?: string;
};

type SenseAudioGetVoiceResponse = {
  system_voice?: SenseAudioVoiceEntry[];
  voice_cloning?: SenseAudioVoiceEntry[];
  voice_generation?: SenseAudioVoiceEntry[];
  base_resp?: SenseAudioBaseResp;
};

export function normalizeSenseAudioTtsBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return DEFAULT_SENSEAUDIO_TTS_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function assertSenseAudioBusinessOk(
  body: { base_resp?: SenseAudioBaseResp } | undefined,
  context: string,
): void {
  const statusCode = body?.base_resp?.status_code;
  if (statusCode === undefined || statusCode === 0) {
    return;
  }
  const statusMsg = body?.base_resp?.status_msg ?? "unknown error";
  throw new Error(`${context}: status_code=${statusCode} ${statusMsg}`);
}

export async function senseAudioTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  voiceId: string;
  timeoutMs: number;
}): Promise<Buffer> {
  const { text, apiKey, baseUrl, model, voiceId, timeoutMs } = params;
  const url = `${normalizeSenseAudioTtsBaseUrl(baseUrl)}/v1/t2a_v2`;
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        text,
        stream: false,
        voice_setting: { voice_id: voiceId },
        audio_setting: {
          sample_rate: TTS_AUDIO_SAMPLE_RATE,
          bitrate: TTS_AUDIO_BITRATE,
          format: TTS_AUDIO_FORMAT,
          channel: TTS_AUDIO_CHANNELS,
        },
      }),
    },
    timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(url),
    auditContext: "senseaudio.tts",
  });
  try {
    await assertOkOrThrowProviderError(response, "SenseAudio TTS API error");
    const body = (await response.json()) as SenseAudioTtsResponse;
    assertSenseAudioBusinessOk(body, "SenseAudio TTS API error");
    const hexAudio = trimToUndefined(body?.data?.audio);
    if (!hexAudio) {
      throw new Error("SenseAudio TTS API returned no audio data");
    }
    return Buffer.from(hexAudio, "hex");
  } finally {
    await release();
  }
}

export async function listSenseAudioSystemVoices(params: {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
}): Promise<SpeechVoiceOption[]> {
  const { apiKey, baseUrl, timeoutMs } = params;
  const url = `${normalizeSenseAudioTtsBaseUrl(baseUrl)}/v1/get_voice`;
  const { response, release } = await fetchWithSsrFGuard({
    url,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ voice_type: "system" }),
    },
    timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(url),
    auditContext: "senseaudio.voices",
  });
  try {
    await assertOkOrThrowProviderError(response, "SenseAudio voices API error");
    const body = (await response.json()) as SenseAudioGetVoiceResponse;
    assertSenseAudioBusinessOk(body, "SenseAudio voices API error");
    const systemVoices = Array.isArray(body?.system_voice) ? body.system_voice : [];
    return systemVoices
      .map((voice): SpeechVoiceOption | undefined => {
        const id = trimToUndefined(voice.voice_id);
        if (!id) {
          return undefined;
        }
        const description = Array.isArray(voice.description)
          ? voice.description.filter((part) => trimToUndefined(part) !== undefined).join(", ")
          : "";
        const option: SpeechVoiceOption = {
          id,
          name: trimToUndefined(voice.voice_name),
          category: "system",
        };
        if (description.length > 0) {
          option.description = description;
        }
        return option;
      })
      .filter((voice): voice is SpeechVoiceOption => voice !== undefined);
  } finally {
    await release();
  }
}
