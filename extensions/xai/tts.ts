import { assertOkOrThrowProviderError, postJsonRequest } from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { trimToUndefined } from "openclaw/plugin-sdk/speech";
// Xai plugin module implements tts behavior.
import { XAI_BASE_URL } from "./api.js";
import { xaiUserAgentHeaderFor } from "./src/xai-user-agent.js";
export { XAI_BASE_URL };

const DEFAULT_TTS_MAX_BYTES = 16 * 1024 * 1024;
export const XAI_TTS_VOICES = ["eve", "ara", "rex", "sal", "leo", "una"] as const;
const XAI_NATIVE_TTS_WS_URL = "wss://api.x.ai/v1/tts";
const XAI_TTS_CLOSE_TIMEOUT_MS = 1_000;
const XAI_TTS_WS_CONNECTING = 0;
const XAI_TTS_WS_OPEN = 1;
const XAI_TTS_WS_CLOSED = 3;

type XaiTtsVoice = (typeof XAI_TTS_VOICES)[number];
type XaiTtsResponseFormat = "mp3" | "wav" | "pcm" | "mulaw" | "alaw";
type XaiTtsWebSocket = {
  readyState: number;
  close: (code?: number, reason?: string) => void;
  send: (data: string) => void;
  addEventListener: (
    event: "open" | "error" | "close" | "message",
    listener: (event: Event | MessageEvent) => void,
    options?: { once?: boolean },
  ) => void;
};
type XaiTtsWebSocketOptions = { headers: Record<string, string>; handshakeTimeout: number };
type XaiTtsWebSocketFactory = (
  url: string,
  options: XaiTtsWebSocketOptions,
) => XaiTtsWebSocket | Promise<XaiTtsWebSocket>;
type XaiTtsNodeWebSocketInit = {
  headers: Record<string, string>;
};
type XaiTtsNodeWebSocketConstructor = new (
  url: string,
  options: XaiTtsNodeWebSocketInit,
) => XaiTtsWebSocket;

function isClosedXaiTtsWebSocket(ws: XaiTtsWebSocket): boolean {
  return ws.readyState === XAI_TTS_WS_CLOSED;
}

export function normalizeXaiTtsBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return XAI_BASE_URL;
  }
  return trimmed.replace(/\/+$/, "");
}

function isNativeXaiTtsBaseUrl(baseUrl: string): boolean {
  const url = new URL(normalizeXaiTtsBaseUrl(baseUrl));
  return url.protocol === "https:" && url.hostname === "api.x.ai" && url.pathname === "/v1";
}

export function isValidXaiTtsVoice(voice: string, baseUrl?: string): voice is XaiTtsVoice {
  const normalizedBase = normalizeXaiTtsBaseUrl(baseUrl ?? process.env.XAI_BASE_URL);
  const host = normalizedBase.includes("://") ? new URL(normalizedBase).hostname : normalizedBase;
  const isNative = host === "api.x.ai";
  if (!isNative) {
    return true;
  }
  return XAI_TTS_VOICES.includes(voice as XaiTtsVoice);
}

export function normalizeXaiLanguageCode(value: unknown): string | undefined {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "auto" || /^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(normalized)) {
    return normalized;
  }
  throw new Error(
    `xAI language must be "auto" or a BCP-47 tag (e.g. "en", "pt-br", "zh-cn"); got: ${normalized}`,
  );
}

export async function xaiTTS(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  language?: string;
  speed?: number;
  responseFormat?: XaiTtsResponseFormat;
  timeoutMs: number;
  maxBytes?: number;
}): Promise<Buffer> {
  const {
    text,
    apiKey,
    baseUrl,
    voiceId,
    language: rawLanguage,
    speed,
    responseFormat = "mp3",
    timeoutMs,
    maxBytes = DEFAULT_TTS_MAX_BYTES,
  } = params;
  const language = normalizeXaiLanguageCode(rawLanguage) ?? "en";

  if (!isValidXaiTtsVoice(voiceId, baseUrl)) {
    throw new Error(`Invalid voice: ${voiceId}`);
  }

  const ttsBaseUrl = normalizeXaiTtsBaseUrl(baseUrl);
  const { response, release } = await postJsonRequest({
    url: `${ttsBaseUrl}/tts`,
    headers: new Headers({
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...xaiUserAgentHeaderFor(ttsBaseUrl),
    }),
    body: {
      text,
      voice_id: voiceId,
      language,
      output_format: {
        codec: responseFormat,
      },
      ...(speed != null && { speed }),
    },
    timeoutMs,
    fetchFn: fetch,
    auditContext: "xai tts",
  });
  try {
    await assertOkOrThrowProviderError(response, "xAI TTS API error");

    return await readResponseWithLimit(response, maxBytes, {
      onOverflow: ({ maxBytes: maxBytesLocal }) =>
        new Error(`xAI TTS audio response exceeds ${maxBytesLocal} bytes`),
    });
  } finally {
    await release();
  }
}

function createXaiTtsAbortError(message: string): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

function messageDataToString(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return String(data);
}

function readXaiTtsErrorMessage(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message.trim();
    }
    if (typeof record.error === "string" && record.error.trim()) {
      return record.error.trim();
    }
  }
  return "xAI streaming TTS error";
}

function errorFromWebSocketEvent(evt: Event | MessageEvent): Error {
  const maybeError = (evt as { error?: unknown }).error;
  if (maybeError instanceof Error) {
    return maybeError;
  }
  if (typeof maybeError === "string" && maybeError.trim()) {
    return new Error(maybeError.trim());
  }
  return new Error("xAI streaming TTS WebSocket error");
}

function buildXaiTtsStreamingUrl(params: {
  baseUrl: string;
  voiceId: string;
  language?: string;
  speed?: number;
  responseFormat?: XaiTtsResponseFormat;
}): string {
  if (!isNativeXaiTtsBaseUrl(params.baseUrl)) {
    throw new Error("xAI streaming TTS requires native xAI baseUrl https://api.x.ai/v1");
  }
  const language = normalizeXaiLanguageCode(params.language) ?? "en";
  const url = new URL(XAI_NATIVE_TTS_WS_URL);
  url.searchParams.set("language", language);
  url.searchParams.set("voice", params.voiceId);
  url.searchParams.set("codec", params.responseFormat ?? "mp3");
  if (params.speed != null) {
    url.searchParams.set("speed", String(params.speed));
  }
  return url.toString();
}

export async function xaiTTSStream(params: {
  text: string;
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  language?: string;
  speed?: number;
  responseFormat?: XaiTtsResponseFormat;
  timeoutMs: number;
  websocketFactory?: XaiTtsWebSocketFactory;
}): Promise<{
  audioStream: ReadableStream<Uint8Array>;
  release: () => Promise<void>;
}> {
  const { text, apiKey, baseUrl, voiceId, responseFormat = "mp3", timeoutMs } = params;

  if (!isValidXaiTtsVoice(voiceId, baseUrl)) {
    throw new Error(`Invalid voice: ${voiceId}`);
  }

  const url = buildXaiTtsStreamingUrl({
    baseUrl,
    voiceId,
    language: params.language,
    speed: params.speed,
    responseFormat,
  });

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    ...xaiUserAgentHeaderFor(XAI_BASE_URL),
  };
  const websocketFactory = params.websocketFactory ?? createXaiTtsWebSocket;
  const wsResult = websocketFactory(url, {
    headers,
    handshakeTimeout: timeoutMs,
  });
  const ws = isPromiseLikeXaiTtsWebSocket(wsResult) ? await wsResult : wsResult;

  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let handoffComplete = false;
  let streamClosed = false;
  let released = false;
  let closeTimer: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;

  const clearTimeouts = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
  };

  const closeSocket = () => {
    if (ws.readyState === XAI_TTS_WS_OPEN || ws.readyState === XAI_TTS_WS_CONNECTING) {
      ws.close(1000, "tts complete");
      if (!isClosedXaiTtsWebSocket(ws)) {
        closeTimer = setTimeout(() => {
          if (!isClosedXaiTtsWebSocket(ws)) {
            ws.close(1000, "tts complete");
          }
        }, XAI_TTS_CLOSE_TIMEOUT_MS);
      }
    }
  };

  const failStream = (err: Error) => {
    clearTimeouts();
    if (!streamClosed) {
      streamClosed = true;
      controller?.error(err);
    }
    closeSocket();
  };

  const release = async () => {
    released = true;
    clearTimeouts();
    if (!streamClosed) {
      streamClosed = true;
      controller?.close();
    }
    closeSocket();
  };

  const audioStream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
    },
    cancel() {
      return release();
    },
  });

  const openPromise = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => {
      const err = createXaiTtsAbortError("xAI streaming TTS timed out");
      if (!handoffComplete) {
        reject(err);
      }
      failStream(err);
    }, timeoutMs);

    ws.addEventListener(
      "open",
      () => {
        try {
          ws.send(JSON.stringify({ type: "text.delta", delta: text }));
          ws.send(JSON.stringify({ type: "text.done" }));
          handoffComplete = true;
          resolve();
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          reject(error);
          failStream(error);
        }
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      (evt) => {
        const err = errorFromWebSocketEvent(evt);
        if (!handoffComplete) {
          reject(err);
          return;
        }
        failStream(err instanceof Error ? err : new Error(String(err)));
      },
      { once: true },
    );
    ws.addEventListener(
      "close",
      () => {
        if (closeTimer) {
          clearTimeout(closeTimer);
          closeTimer = undefined;
        }
        if (!handoffComplete) {
          reject(new Error("xAI streaming TTS connection closed before ready"));
          return;
        }
        if (!streamClosed && !released) {
          failStream(new Error("xAI streaming TTS connection closed before audio.done"));
        }
      },
      { once: true },
    );
  });

  ws.addEventListener("message", (evt) => {
    if (streamClosed) {
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(messageDataToString((evt as MessageEvent).data)) as Record<
        string,
        unknown
      >;
    } catch {
      failStream(new Error("xAI streaming TTS returned malformed JSON"));
      return;
    }
    switch (event.type) {
      case "audio.delta": {
        if (typeof event.delta !== "string") {
          failStream(new Error("xAI streaming TTS audio.delta missing base64 payload"));
          return;
        }
        controller?.enqueue(Buffer.from(event.delta, "base64"));
        return;
      }
      case "audio.done":
        clearTimeouts();
        if (!streamClosed) {
          streamClosed = true;
          controller?.close();
        }
        closeSocket();
        return;
      case "error":
        failStream(new Error(readXaiTtsErrorMessage(event.message ?? event.error)));
      default:
    }
  });

  try {
    await openPromise;
    return { audioStream, release };
  } catch (err) {
    await release();
    throw err;
  }
}

async function createXaiTtsWebSocket(
  url: string,
  options: XaiTtsWebSocketOptions,
): Promise<XaiTtsWebSocket> {
  const NodeWebSocket = WebSocket as unknown as XaiTtsNodeWebSocketConstructor;
  return new NodeWebSocket(url, {
    headers: options.headers,
  });
}

function isPromiseLikeXaiTtsWebSocket(
  value: XaiTtsWebSocket | Promise<XaiTtsWebSocket>,
): value is Promise<XaiTtsWebSocket> {
  return typeof (value as { then?: unknown }).then === "function";
}
