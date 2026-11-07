import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { toStringifiedError } from "openclaw/plugin-sdk/error-runtime";
import { canonicalizeBase64, rawDataToString } from "openclaw/plugin-sdk/realtime-voice-provider";
import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech";

export const HEYGEN_MODELS = [
  "heygen-voice-1",
  "heygen-voice-1-turbo",
  "heygen-voice-1-turbo-free",
] as const;
export type HeyGenModel = (typeof HEYGEN_MODELS)[number];

export const HEYGEN_MP3_OUTPUT = { encoding: "mp3", sample_rate_hertz: 44_100 } as const;
export const HEYGEN_PCM_OUTPUT = { encoding: "pcm", sample_rate_hertz: 24_000 } as const;
const HEYGEN_SOCKET_MP3_OUTPUT = "mp3_44100_128";

const HEYGEN_ERROR_LABEL = "HeyGen TTS API error";
const HEYGEN_VOICE_PAGE_SIZE = 100;
const HEYGEN_MAX_OWN_VOICE_PAGES = 20;
const HEYGEN_VOICES_MAX_BYTES = 2 * 1024 * 1024;

export type HeyGenTtsRequest = {
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

async function requestHeyGenTts(params: HeyGenTtsRequest, outputFormat: HeyGenOutputFormat) {
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedHostname } =
    await import("openclaw/plugin-sdk/ssrf-runtime");
  return await fetchWithSsrFGuard({
    url: `${params.baseUrl}/v3/models/audio/tts/stream`,
    init: {
      method: "POST",
      headers: { "x-api-key": params.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: params.text,
        voice_id: params.voiceId,
        model: params.model,
        ...(params.language ? { language: params.language } : {}),
        output_format: outputFormat,
      }),
    },
    timeoutMs: params.timeoutMs,
    policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(params.baseUrl),
    auditContext: "heygen.tts",
  });
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

export async function heygenHttpTtsStream(params: HeyGenTtsRequest): Promise<HeyGenAudioStream> {
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

type HeyGenSocketFrame = {
  audio?: string | null;
  isFinal?: boolean | null;
  error?: { request_id?: string };
};

function toFetchResponse(response: IncomingMessage): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== undefined) {
      headers.set(name, String(value));
    }
  }
  return new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
    status: response.statusCode,
    headers,
  });
}

// One complete text per socket. `stream-input` synthesizes what it holds when the text ends,
// whereas `multi-stream-input` adds per-context admission that one-shot speech has no use for.
export async function heygenSocketTtsStream(params: HeyGenTtsRequest): Promise<HeyGenAudioStream> {
  const url = new URL(`${params.baseUrl}/v3/models/audio/tts/stream-input`);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.searchParams.set("voice_id", params.voiceId);
  url.searchParams.set("model", params.model);
  url.searchParams.set("output_format", HEYGEN_SOCKET_MP3_OUTPUT);
  if (params.language) {
    url.searchParams.set("language", params.language);
  }

  const { createProviderHttpError, formatProviderErrorPayload, openProviderWebSocket } =
    await import("openclaw/plugin-sdk/provider-http");
  const requestHeaders = { "x-api-key": params.apiKey };
  const socket = await openProviderWebSocket({
    allowPrivateNetwork: false,
    baseUrl: params.baseUrl,
    headers: requestHeaders,
    timeoutMs: params.timeoutMs,
    trustConfiguredBaseUrlOrigin: false,
    url: url.toString(),
  });

  // Resolving on the first audio keeps refusals sent after the handshake, such as Turbo Free
  // capacity, on the path where core can still try the next provider.
  return await new Promise((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let settled = false;
    let started = false;
    let totalBytes = 0;
    let watchdog: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      settled = true;
      clearTimeout(watchdog);
      socket.close();
    };

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      stop();
      if (!started) {
        reject(error ?? new Error("HeyGen TTS stream returned no audio"));
      } else if (error) {
        controller?.error(error);
      } else {
        controller?.close();
      }
    };

    const refreshWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(
        () => finish(new Error("HeyGen TTS stream timed out")),
        params.timeoutMs,
      );
    };

    const audioStream = new ReadableStream<Uint8Array>({
      start: (streamController) => {
        controller = streamController;
      },
      cancel: stop,
    });

    const handleFrame = (frame: HeyGenSocketFrame) => {
      if (frame.error) {
        const requestId = frame.error.request_id;
        finish(
          new Error(
            `${HEYGEN_ERROR_LABEL}: ${formatProviderErrorPayload(frame)}${
              requestId ? ` [request_id=${requestId}]` : ""
            }`,
          ),
        );
        return;
      }
      if (frame.audio) {
        const audio = canonicalizeBase64(frame.audio);
        if (!audio) {
          throw new Error("HeyGen TTS stream returned malformed base64 audio");
        }
        const chunk = Buffer.from(audio, "base64");
        totalBytes += chunk.length;
        if (totalBytes > params.maxBytes) {
          throw new Error(`HeyGen TTS audio stream exceeds ${params.maxBytes} bytes`);
        }
        controller?.enqueue(new Uint8Array(chunk));
        refreshWatchdog();
        if (!started) {
          started = true;
          resolve({ audioStream, release: async () => finish() });
        }
      }
      if (frame.isFinal) {
        finish();
      }
    };

    refreshWatchdog();

    socket.once("unexpected-response", (_request, response) => {
      void Promise.resolve()
        .then(() =>
          createProviderHttpError(toFetchResponse(response), HEYGEN_ERROR_LABEL, {
            requestHeaders,
          }),
        )
        .then(finish, finish);
    });

    socket.on("error", (error) => finish(toStringifiedError(error)));

    socket.once("close", (code, reason) => {
      finish(
        new Error(`HeyGen TTS stream closed before final audio (${code}): ${reason.toString()}`),
      );
    });

    socket.once("open", () => {
      socket.send(JSON.stringify({ text: params.text }));
      socket.send(JSON.stringify({ text: "" }));
    });

    socket.on("message", (data) => {
      if (settled) {
        return;
      }
      try {
        handleFrame(JSON.parse(rawDataToString(data)) as HeyGenSocketFrame);
      } catch (error) {
        finish(toStringifiedError(error));
      }
    });
  });
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
  has_more?: boolean;
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
    if (!page.has_more || !token) {
      break;
    }
  }
  try {
    voices.push(...parseVoices(await requestVoicePage("public")));
  } catch {
    // Workspace voices remain useful when the public catalog is temporarily unavailable.
  }
  return voices;
}
