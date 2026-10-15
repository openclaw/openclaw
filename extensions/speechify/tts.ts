import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech";
import {
  asOptionalRecord,
  normalizeTrimmedStringList,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  SPEECHIFY_API_HOSTNAMES,
  normalizeSpeechifyBaseUrl,
  speechifyRequestHeaders,
} from "./shared.js";

// The voice catalog is a single JSON array of about a thousand entries with
// preview and avatar URLs; 8 MiB leaves room for growth without buffering junk.
const SPEECHIFY_VOICES_MAX_BYTES = 8 * 1024 * 1024;
const SPEECHIFY_VOICES_MAX_PAGES = 20;

/**
 * Container the streaming endpoint is asked for through `Accept`.
 * ogg is Opus at 48 kHz, mp3 and pcm are 24 kHz mono, pcm is signed 16-bit little-endian.
 */
export type SpeechifyAudioFormat = "mp3" | "ogg" | "pcm";

const SPEECHIFY_ACCEPT: Record<SpeechifyAudioFormat, string> = {
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  pcm: "audio/pcm",
};

export type SpeechifyTtsRequest = {
  text: string;
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  model: string;
  language?: string;
  format: SpeechifyAudioFormat;
  timeoutMs: number;
  maxBytes: number;
};

function buildSpeechifyRequestBody(params: SpeechifyTtsRequest): string {
  return JSON.stringify({
    input: params.text,
    voice_id: params.voiceId,
    model: params.model,
    ...(params.language ? { language: params.language } : {}),
  });
}

async function requestSpeechifyTts(params: SpeechifyTtsRequest): Promise<{
  response: Response;
  release: () => Promise<void>;
}> {
  const baseUrl = normalizeSpeechifyBaseUrl(params.baseUrl);
  const { fetchWithSsrFGuard } = await import("openclaw/plugin-sdk/ssrf-runtime");
  return await fetchWithSsrFGuard({
    url: `${baseUrl}/v1/audio/stream`,
    init: {
      method: "POST",
      headers: {
        ...speechifyRequestHeaders(params.apiKey),
        "Content-Type": "application/json",
        Accept: SPEECHIFY_ACCEPT[params.format],
      },
      body: buildSpeechifyRequestBody(params),
    },
    timeoutMs: params.timeoutMs,
    requireHttps: true,
    // Keep the transport boundary independent from config normalization so a
    // future validator relaxation cannot silently widen credential egress.
    policy: { hostnameAllowlist: [...SPEECHIFY_API_HOSTNAMES] },
    auditContext: "speechify.tts",
  });
}

export async function speechifyTts(params: SpeechifyTtsRequest): Promise<Buffer> {
  const { assertOkOrThrowProviderError, readProviderBinaryResponse } =
    await import("openclaw/plugin-sdk/provider-http");
  const { response, release } = await requestSpeechifyTts(params);
  try {
    await assertOkOrThrowProviderError(response, "Speechify API error");
    return await readProviderBinaryResponse(response, "Speechify API error", "audio", {
      maxBytes: params.maxBytes,
      onOverflow: ({ maxBytes }) =>
        new Error(`Speechify TTS audio response exceeds ${maxBytes} bytes`),
    });
  } finally {
    await release();
  }
}

export async function speechifyTtsStream(params: SpeechifyTtsRequest): Promise<{
  audioStream: ReadableStream<Uint8Array>;
  release: () => Promise<void>;
}> {
  const { createBoundedProviderBinaryStream } =
    await import("openclaw/plugin-sdk/provider-binary-stream");
  const { assertOkOrThrowProviderError, assertProviderBinaryResponseContent } =
    await import("openclaw/plugin-sdk/provider-http");
  const { response, release } = await requestSpeechifyTts(params);
  let handedOff = false;
  try {
    await assertOkOrThrowProviderError(response, "Speechify API error");
    assertProviderBinaryResponseContent(response, "Speechify API error", "audio");
    if (!response.body) {
      throw new Error("Speechify API response missing audio stream");
    }
    const bounded = createBoundedProviderBinaryStream(response.body, {
      maxBytes: params.maxBytes,
      createOverflowError: ({ maxBytes }) =>
        new Error(`Speechify API error: audio response exceeds ${maxBytes} bytes`),
      createReleaseError: () => new Error("Speechify TTS stream released"),
      cleanup: release,
    });
    handedOff = true;
    return { audioStream: bounded.stream, release: bounded.release };
  } finally {
    if (!handedOff) {
      await release();
    }
  }
}

type SpeechifyVoicePayload =
  | unknown[]
  | {
      voices?: unknown[];
      next_cursor?: string | null;
      has_more?: boolean;
    };

function parseVoiceItem(value: unknown): SpeechVoiceOption | undefined {
  const item = asOptionalRecord(value);
  const id = trimToUndefined(item?.id);
  if (!id) {
    return undefined;
  }
  const models = Array.isArray(item?.models)
    ? item.models.flatMap((model) => trimToUndefined(asOptionalRecord(model)?.name) ?? [])
    : [];
  const tags = normalizeTrimmedStringList(item?.tags);
  return {
    id,
    name: trimToUndefined(item?.display_name),
    // Which models render this voice; a voice/model mismatch is an HTTP 400.
    description: models.length > 0 ? `Models: ${models.join(", ")}` : undefined,
    category: trimToUndefined(item?.type),
    locale: trimToUndefined(item?.locale),
    gender: trimToUndefined(item?.gender),
    personalities: tags.length > 0 ? tags : undefined,
  };
}

async function requestVoicePage(params: {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  cursor?: string;
}): Promise<SpeechifyVoicePayload> {
  const url = new URL(`${normalizeSpeechifyBaseUrl(params.baseUrl)}/v1/voices`);
  if (params.cursor) {
    url.searchParams.set("cursor", params.cursor);
  }
  const { assertOkOrThrowProviderError, readProviderJsonResponse } =
    await import("openclaw/plugin-sdk/provider-http");
  const { fetchWithSsrFGuard } = await import("openclaw/plugin-sdk/ssrf-runtime");
  const { response, release } = await fetchWithSsrFGuard({
    url: url.toString(),
    init: { headers: speechifyRequestHeaders(params.apiKey) },
    timeoutMs: params.timeoutMs,
    requireHttps: true,
    policy: { hostnameAllowlist: [...SPEECHIFY_API_HOSTNAMES] },
    auditContext: "speechify.voices",
  });
  try {
    await assertOkOrThrowProviderError(response, "Speechify voices API error");
    return await readProviderJsonResponse<SpeechifyVoicePayload>(response, "Speechify voices", {
      maxBytes: SPEECHIFY_VOICES_MAX_BYTES,
    });
  } finally {
    await release();
  }
}

/**
 * Lists the voices the API key can use. The endpoint returns one JSON array
 * today; a paginated `{ voices, next_cursor, has_more }` shape is followed for
 * a bounded number of pages in case the catalog starts paging.
 */
export async function listSpeechifyVoices(params: {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}): Promise<SpeechVoiceOption[]> {
  const voices: SpeechVoiceOption[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < SPEECHIFY_VOICES_MAX_PAGES; page += 1) {
    const payload = await requestVoicePage({ ...params, cursor });
    const items = Array.isArray(payload) ? payload : (payload.voices ?? []);
    voices.push(...items.flatMap((item) => parseVoiceItem(item) ?? []));
    if (Array.isArray(payload) || !payload.has_more || !payload.next_cursor) {
      break;
    }
    cursor = payload.next_cursor;
  }
  return voices;
}
