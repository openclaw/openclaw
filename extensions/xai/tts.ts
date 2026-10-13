import { toStringifiedError } from "openclaw/plugin-sdk/error-runtime";
import { canonicalizeBase64, rawDataToString } from "openclaw/plugin-sdk/realtime-voice-provider";
import type { SpeechVoiceOption } from "openclaw/plugin-sdk/speech";
import {
  asOptionalRecord,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { XAI_BASE_URL } from "./model-definitions.js";
import {
  isValidXaiTtsVoice,
  normalizeXaiLanguageCode,
  normalizeXaiTtsBaseUrl,
  type XaiSpeechResponseFormat,
} from "./speech-provider-metadata.js";
import { xaiUserAgentHeaderFor } from "./src/xai-user-agent.js";
import { WebSocket } from "./ws-runtime.js";

const DEFAULT_TTS_MAX_BYTES = 16 * 1024 * 1024;
const XAI_TTS_VOICE_LIST_TIMEOUT_MS = 30_000;
const XAI_TTS_VOICE_LIST_MAX_BYTES = 1024 * 1024;
const XAI_TTS_STREAM_TEXT_DELTA_MAX_CHARS = 15_000;
export async function listXaiTtsVoices(params: {
  apiKey: string;
  baseUrl?: string;
}): Promise<SpeechVoiceOption[]> {
  const baseUrl = normalizeXaiTtsBaseUrl(params.baseUrl);
  const { assertOkOrThrowProviderError, readProviderJsonArrayFieldResponse } =
    await import("openclaw/plugin-sdk/provider-http");
  const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedOrigin } =
    await import("openclaw/plugin-sdk/ssrf-runtime");
  const { response, release } = await fetchWithSsrFGuard({
    url: `${baseUrl}/tts/voices`,
    init: {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        ...xaiUserAgentHeaderFor(baseUrl),
      },
    },
    timeoutMs: XAI_TTS_VOICE_LIST_TIMEOUT_MS,
    policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl),
    auditContext: "xai tts voices",
  });
  try {
    await assertOkOrThrowProviderError(response, "xAI TTS voices API error");
    const voices = await readProviderJsonArrayFieldResponse(response, "xAI TTS voices", "voices", {
      maxBytes: XAI_TTS_VOICE_LIST_MAX_BYTES,
    });
    return voices.flatMap((value) => {
      const voice = asOptionalRecord(value);
      const id = trimToUndefined(voice?.voice_id);
      if (!id) {
        return [];
      }
      return [
        {
          id,
          name: trimToUndefined(voice?.name),
          locale: trimToUndefined(voice?.language),
          gender: trimToUndefined(voice?.gender),
        },
      ];
    });
  } finally {
    await release();
  }
}

type XaiTtsRequest = {
  text: string;
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  language?: string;
  speed?: number;
  responseFormat?: XaiSpeechResponseFormat;
  timeoutMs: number;
  maxBytes?: number;
};

function prepareXaiTtsRequest({
  language: rawLanguage,
  responseFormat = "mp3",
  maxBytes = DEFAULT_TTS_MAX_BYTES,
  ...request
}: XaiTtsRequest) {
  const language = normalizeXaiLanguageCode(rawLanguage) ?? "en";
  if (!isValidXaiTtsVoice(request.voiceId)) {
    throw new Error(`Invalid voice: ${request.voiceId}`);
  }
  return { ...request, language, responseFormat, maxBytes };
}

const XAI_NATIVE_TTS_STREAM_HOST = "api.x.ai";

type XaiTtsStreamServerEvent = {
  type?: string;
  delta?: string;
  message?: string;
};

function toXaiTtsWsUrl(params: {
  baseUrl: string;
  voiceId: string;
  language: string;
  responseFormat: XaiSpeechResponseFormat;
  speed?: number;
}): string {
  const url = resolveXaiNativeTtsStreamEndpoint(params.baseUrl);
  url.protocol = "wss:";
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/tts`;
  url.searchParams.set("language", params.language);
  url.searchParams.set("voice", params.voiceId);
  url.searchParams.set("codec", params.responseFormat);
  if (params.speed != null) {
    url.searchParams.set("speed", String(params.speed));
  }
  return url.toString();
}

function resolveXaiNativeTtsStreamEndpoint(baseUrl: string): URL {
  const url = URL.parse(normalizeXaiTtsBaseUrl(baseUrl));
  if (!url) {
    throw new Error(`Invalid xAI TTS stream baseUrl: ${baseUrl}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `xAI streaming TTS only supports HTTPS for the native ${XAI_NATIVE_TTS_STREAM_HOST} endpoint; got protocol "${url.protocol}"`,
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== XAI_NATIVE_TTS_STREAM_HOST) {
    throw new Error(
      `xAI streaming TTS only supports the native ${XAI_NATIVE_TTS_STREAM_HOST} endpoint; got host "${hostname}"`,
    );
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  if (url.username || url.password || url.port || pathname !== "/v1" || url.search || url.hash) {
    throw new Error(`xAI streaming TTS requires the canonical ${XAI_BASE_URL} base URL`);
  }
  return url;
}

export async function xaiTTSStream(request: XaiTtsRequest): Promise<{
  audioStream: ReadableStream<Uint8Array>;
  release: () => Promise<void>;
}> {
  const params = prepareXaiTtsRequest(request);
  const wsUrl = toXaiTtsWsUrl(params);
  // Bound the encoded JSON frame before ws buffers it. Base64 expands audio by
  // roughly 4/3; the fixed allowance covers the event envelope and metadata.
  const maxPayload = Math.ceil(params.maxBytes / 3) * 4 + 1024;

  // Wire the socket before the first yield; deferred imports can miss immediate transport events.
  return await new Promise((resolve, reject) => {
    let connectSettled = false;
    let released = false;
    let synthesisTimer: ReturnType<typeof setTimeout> | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let ws: WebSocket | undefined;
    let errorStream: ((error: Error) => void) | undefined;
    let closeStream: (() => void) | undefined;
    let streamClosed = false;

    const clearTimers = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
      if (synthesisTimer) {
        clearTimeout(synthesisTimer);
        synthesisTimer = undefined;
      }
    };

    const release = async () => {
      if (released) {
        return;
      }
      released = true;
      clearTimers();
      closeStream?.();
      const socket = ws;
      ws = undefined;
      if (!socket) {
        return;
      }
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      } else if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
      }
    };

    const failConnect = (error: Error) => {
      if (connectSettled) {
        return;
      }
      connectSettled = true;
      clearTimers();
      void release();
      reject(error);
    };

    const failStream = (error: Error) => {
      if (released || streamClosed) {
        return;
      }
      clearTimers();
      errorStream?.(error);
      void release();
    };

    // Refresh the watchdog while xAI is sending audio so it measures idle time.
    const refreshSynthesisTimer = () => {
      if (synthesisTimer) {
        clearTimeout(synthesisTimer);
      }
      synthesisTimer = setTimeout(() => {
        failStream(new Error("xAI TTS stream synthesis timeout"));
      }, params.timeoutMs);
    };

    try {
      ws = new WebSocket(wsUrl, {
        maxPayload,
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          ...xaiUserAgentHeaderFor(params.baseUrl),
        },
      });
    } catch (error) {
      failConnect(toStringifiedError(error));
      return;
    }

    connectTimer = setTimeout(() => {
      failConnect(new Error("xAI TTS stream connection timeout"));
    }, params.timeoutMs);

    ws.once("unexpected-response", (_request, response) => {
      failConnect(
        new Error(
          `xAI TTS stream connection failed (${response.statusCode ?? "unknown"}): ${
            response.statusMessage ?? "upgrade rejected"
          }`,
        ),
      );
    });

    ws.once("error", (error) => {
      const normalized = toStringifiedError(error);
      if (connectSettled) {
        failStream(normalized);
        return;
      }
      failConnect(normalized);
    });

    ws.once("close", () => {
      if (connectSettled) {
        return;
      }
      failConnect(new Error("xAI TTS stream connection closed before open"));
    });

    ws.once("open", () => {
      if (connectSettled) {
        return;
      }
      connectSettled = true;
      clearTimers();
      refreshSynthesisTimer();

      let totalBytes = 0;
      let enqueue: ((chunk: Uint8Array) => void) | undefined;

      const wiredStream = new ReadableStream<Uint8Array>({
        start(streamController) {
          enqueue = (chunk) => {
            if (streamClosed) {
              return;
            }
            streamController.enqueue(chunk);
          };
          closeStream = () => {
            if (streamClosed) {
              return;
            }
            streamClosed = true;
            streamController.close();
          };
          errorStream = (error) => {
            if (streamClosed) {
              return;
            }
            streamClosed = true;
            streamController.error(error);
          };
        },
        cancel() {
          streamClosed = true;
          void release();
        },
      });

      const handleServerEvent = (event: XaiTtsStreamServerEvent) => {
        switch (event.type) {
          case "audio.delta": {
            const encoded = trimToUndefined(event.delta);
            if (!encoded) {
              return;
            }
            const canonicalAudio = canonicalizeBase64(encoded);
            if (!canonicalAudio) {
              failStream(new Error("xAI TTS stream returned malformed base64 audio data"));
              return;
            }
            const chunk = Buffer.from(canonicalAudio, "base64");
            totalBytes += chunk.length;
            if (totalBytes > params.maxBytes) {
              errorStream?.(new Error(`xAI TTS audio stream exceeds ${params.maxBytes} bytes`));
              void release();
              return;
            }
            enqueue?.(new Uint8Array(chunk));
            refreshSynthesisTimer();
            return;
          }
          case "audio.done":
            clearTimers();
            closeStream?.();
            void release();
            return;
          case "error":
            failStream(new Error(trimToUndefined(event.message) ?? "xAI TTS stream error"));
          default:
        }
      };

      ws?.on("message", (data) => {
        if (streamClosed || released) {
          return;
        }
        try {
          const payload = rawDataToString(data);
          handleServerEvent(JSON.parse(payload) as XaiTtsStreamServerEvent);
        } catch (error) {
          failStream(toStringifiedError(error));
        }
      });

      ws?.on("close", () => {
        if (streamClosed || released) {
          return;
        }
        failStream(new Error("xAI TTS stream closed before audio.done"));
      });

      try {
        for (let offset = 0; offset < params.text.length;) {
          const delta = sliceUtf16Safe(
            params.text,
            offset,
            offset + XAI_TTS_STREAM_TEXT_DELTA_MAX_CHARS,
          );
          ws?.send(
            JSON.stringify({
              type: "text.delta",
              delta,
            }),
          );
          offset += delta.length;
        }
        ws?.send(JSON.stringify({ type: "text.done" }));
      } catch (error) {
        failStream(toStringifiedError(error));
      }

      resolve({ audioStream: wiredStream, release });
    });
  });
}

export async function xaiTTS(request: XaiTtsRequest): Promise<Buffer> {
  const params = prepareXaiTtsRequest(request);
  const ttsBaseUrl = normalizeXaiTtsBaseUrl(params.baseUrl);
  const { assertOkOrThrowProviderError, postJsonRequest, readProviderBinaryResponse } =
    await import("openclaw/plugin-sdk/provider-http");
  const { ssrfPolicyFromHttpBaseUrlAllowedOrigin } =
    await import("openclaw/plugin-sdk/ssrf-runtime");
  const { response, release } = await postJsonRequest({
    url: `${ttsBaseUrl}/tts`,
    headers: new Headers({
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
      ...xaiUserAgentHeaderFor(ttsBaseUrl),
    }),
    body: {
      text: params.text,
      voice_id: params.voiceId,
      language: params.language,
      output_format: {
        codec: params.responseFormat,
      },
      ...(params.speed != null && { speed: params.speed }),
    },
    timeoutMs: params.timeoutMs,
    fetchFn: fetch,
    ssrfPolicy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(ttsBaseUrl),
    auditContext: "xai tts",
  });
  try {
    await assertOkOrThrowProviderError(response, "xAI TTS API error");

    return await readProviderBinaryResponse(response, "xAI TTS API error", "audio", {
      maxBytes: params.maxBytes,
      onOverflow: ({ maxBytes: maxBytesLocal }) =>
        new Error(`xAI TTS audio response exceeds ${maxBytesLocal} bytes`),
    });
  } finally {
    await release();
  }
}
