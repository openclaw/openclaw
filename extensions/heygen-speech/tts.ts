import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech";

export const HEYGEN_MODELS = [
  "heygen-voice-1",
  "heygen-voice-1-turbo",
  "heygen-voice-1-turbo-free",
] as const;
export type HeyGenModel = (typeof HEYGEN_MODELS)[number];

export const HEYGEN_MP3_OUTPUT = { encoding: "mp3", sample_rate_hertz: 44_100 } as const;
export const HEYGEN_PCM_OUTPUT = { encoding: "pcm", sample_rate_hertz: 24_000 } as const;

const HEYGEN_ERROR_LABEL = "HeyGen TTS API error";
const HEYGEN_VOICE_PAGE_SIZE = 100;
const HEYGEN_MAX_OWN_VOICE_PAGES = 20;
const HEYGEN_VOICES_MAX_BYTES = 2 * 1024 * 1024;

type HeyGenTtsRequest = {
  text: string;
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  model: HeyGenModel;
  language?: string;
  timeoutMs: number;
  maxBytes: number;
};

type HeyGenAudioStream = {
  audioStream: ReadableStream<Uint8Array>;
  release: () => Promise<void>;
};

type HeyGenOutputFormat = typeof HEYGEN_MP3_OUTPUT | typeof HEYGEN_PCM_OUTPUT;

// The guard's timeout covers the whole body. Playback reads a long reply for minutes.
function refreshTimeoutOnEachChunk(response: Response, refreshTimeout?: () => void): Response {
  const refresh = new TransformStream<Uint8Array, Uint8Array>({
    transform: (chunk, controller) => {
      refreshTimeout?.();
      controller.enqueue(chunk);
    },
  });
  return response.body ? new Response(response.body.pipeThrough(refresh), response) : response;
}

async function requestHeyGenTts(params: HeyGenTtsRequest, outputFormat: HeyGenOutputFormat) {
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedHostname } =
    await import("openclaw/plugin-sdk/ssrf-runtime");
  const { response, release, refreshTimeout } = await fetchWithSsrFGuard({
    url: `${params.baseUrl}/v3/models/audio/tts/stream`,
    init: {
      method: "POST",
      headers: { "x-api-key": params.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: params.text,
        voice_id: params.voiceId,
        model: params.model,
        language: params.language,
        output_format: outputFormat,
      }),
    },
    timeoutMs: params.timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(params.baseUrl),
    auditContext: "heygen.tts",
  });
  return { response: refreshTimeoutOnEachChunk(response, refreshTimeout), release };
}

export async function heygenTts(
  params: HeyGenTtsRequest,
  outputFormat: HeyGenOutputFormat,
): Promise<Buffer> {
  const { assertOkOrThrowProviderError, readProviderBinaryResponse } =
    await import("openclaw/plugin-sdk/provider-http");
  const { response, release } = await requestHeyGenTts(params, outputFormat);
  try {
    await assertOkOrThrowProviderError(response, HEYGEN_ERROR_LABEL, {
      requestHeaders: { "x-api-key": params.apiKey },
    });
    return await readProviderBinaryResponse(response, HEYGEN_ERROR_LABEL, "audio", {
      maxBytes: params.maxBytes,
    });
  } finally {
    await release();
  }
}

export async function heygenTtsStream(params: HeyGenTtsRequest): Promise<HeyGenAudioStream> {
  const { createBoundedProviderBinaryStream } =
    await import("openclaw/plugin-sdk/provider-binary-stream");
  const { assertOkOrThrowProviderError, assertProviderBinaryResponseContent } =
    await import("openclaw/plugin-sdk/provider-http");
  const { response, release } = await requestHeyGenTts(params, HEYGEN_MP3_OUTPUT);
  try {
    await assertOkOrThrowProviderError(response, HEYGEN_ERROR_LABEL, {
      requestHeaders: { "x-api-key": params.apiKey },
    });
    assertProviderBinaryResponseContent(response, HEYGEN_ERROR_LABEL, "audio");
    if (!response.body) {
      throw new Error(`${HEYGEN_ERROR_LABEL}: response missing audio stream`);
    }
    const bounded = createBoundedProviderBinaryStream(response.body, {
      maxBytes: params.maxBytes,
      createOverflowError: ({ maxBytes }) =>
        new Error(`${HEYGEN_ERROR_LABEL}: audio response exceeds ${maxBytes} bytes`),
      createReleaseError: () => new Error("HeyGen TTS stream released"),
      cleanup: release,
    });
    return { audioStream: bounded.stream, release: bounded.release };
  } catch (error) {
    await release();
    throw error;
  }
}

type HeyGenVoice = {
  voice_id?: string;
  mode?: string;
  name?: string;
  language?: string | null;
  status?: string;
};

type HeyGenVoicePage = {
  data?: HeyGenVoice[];
  next_token?: string | null;
};

function parseVoices(page: HeyGenVoicePage): SpeechVoiceOption[] {
  return (page.data ?? []).flatMap((voice) =>
    voice.voice_id && voice.status === "ACTIVE"
      ? [
          {
            id: voice.voice_id,
            name: voice.name,
            category: voice.mode,
            locale: voice.language ?? undefined,
          },
        ]
      : [],
  );
}

export async function listHeyGenVoices(params: {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}): Promise<SpeechVoiceOption[]> {
  const { assertOkOrThrowProviderError, readProviderJsonResponse } =
    await import("openclaw/plugin-sdk/provider-http");
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedHostname } =
    await import("openclaw/plugin-sdk/ssrf-runtime");
  const requestHeaders = { "x-api-key": params.apiKey };
  const requestVoicePage = async (type: "private" | "public", token?: string) => {
    const url = new URL(`${params.baseUrl}/v3/models/audio/voices`);
    url.searchParams.set("type", type);
    url.searchParams.set("limit", String(HEYGEN_VOICE_PAGE_SIZE));
    if (token) {
      url.searchParams.set("token", token);
    }
    const { response, release } = await fetchWithSsrFGuard({
      url: url.toString(),
      init: { headers: requestHeaders },
      timeoutMs: params.timeoutMs,
      policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(params.baseUrl),
      auditContext: "heygen.voices",
    });
    try {
      await assertOkOrThrowProviderError(response, "HeyGen voices API error", { requestHeaders });
      return await readProviderJsonResponse<HeyGenVoicePage>(response, "HeyGen voices", {
        maxBytes: HEYGEN_VOICES_MAX_BYTES,
        requestHeaders,
      });
    } finally {
      await release();
    }
  };

  const voices: SpeechVoiceOption[] = [];
  let token: string | undefined;
  for (let pageNumber = 0; pageNumber < HEYGEN_MAX_OWN_VOICE_PAGES; pageNumber += 1) {
    const page = await requestVoicePage("private", token);
    voices.push(...parseVoices(page));
    token = page.next_token ?? undefined;
    if (!token) {
      break;
    }
  }
  try {
    voices.push(...parseVoices(await requestVoicePage("public")));
  } catch {
    // Workspace voices stay usable when the public list fails.
  }
  return voices;
}
