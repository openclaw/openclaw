// Deepgram Flux voice-note transcription uses the provider's one-shot WebSocket protocol.
import { open } from "node:fs/promises";
import { resolveFfmpegBin } from "openclaw/plugin-sdk/media-ffmpeg";
import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
} from "openclaw/plugin-sdk/media-understanding";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import {
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  openProviderWebSocket,
} from "openclaw/plugin-sdk/provider-http";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { setDeepgramQueryParam } from "./audio-query.js";

const DEEPGRAM_FLUX_SAMPLE_RATE = 16_000;
// Deepgram recommends 80 ms chunks. 16 kHz mono linear16 contains 32 bytes per millisecond.
const DEEPGRAM_FLUX_AUDIO_CHUNK_BYTES = 2_560;
const DEEPGRAM_FLUX_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEEPGRAM_FLUX_MAX_TRANSCRIPT_BYTES = 256 * 1024;
const DEEPGRAM_FLUX_QUERY_KEYS = new Set([
  "eager_eot_threshold",
  "eot_threshold",
  "eot_timeout_ms",
  "keyterm",
  "language_hint",
  "mip_opt_out",
  "numerals",
  "profanity_filter",
  "redact",
  "tag",
]);

export function isDeepgramFluxModel(model?: string): boolean {
  return model?.trim().toLowerCase().startsWith("flux-") ?? false;
}

function readFluxEvent(data: Buffer | ArrayBuffer | Buffer[]): Record<string, unknown> {
  const bytes = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Audio transcription failed: malformed JSON response");
  }
  const event = asOptionalRecord(parsed);
  if (!event) {
    throw new Error("Audio transcription failed: malformed JSON response");
  }
  return event;
}

function readFluxErrorDetail(event: Record<string, unknown>): string {
  const nested = asOptionalRecord(event.error);
  for (const value of [event.description, event.message, nested?.message]) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "Deepgram Flux transcription error";
}

type DeepgramFluxSocket = Awaited<ReturnType<typeof openProviderWebSocket>>;

function sendSocketFrame(socket: DeepgramFluxSocket, data: Buffer | string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.send(data, (error) => (error ? reject(error) : resolve()));
  });
}

export async function transcribeDeepgramFluxAudio(params: {
  request: AudioTranscriptionRequest;
  requestConfig: {
    allowPrivateNetwork: boolean;
    baseUrl: string;
    dispatcherPolicy?: Parameters<typeof openProviderWebSocket>[0]["dispatcherPolicy"];
    headers: Headers;
    trustConfiguredBaseUrlOrigin: boolean;
  };
  model: string;
}): Promise<AudioTranscriptionResult> {
  const deadline = createProviderOperationDeadline({
    timeoutMs: params.request.timeoutMs,
    label: "Deepgram Flux transcription",
  });
  const resolveTimeoutMs = createProviderOperationTimeoutResolver({
    deadline,
    defaultTimeoutMs: params.request.timeoutMs,
  });
  // Keep complete decoded audio off the heap; the workspace owns cleanup on every exit.
  await using workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "audio-transcription-",
  });
  const pcmPath = workspace.path("audio.pcm");
  const sourceBuffer = params.request.buffer;
  const decodeSignal = params.request.signal;
  const decodeTimeoutMs = resolveTimeoutMs();
  const decodeResult = await runCommandBuffered(
    [
      resolveFfmpegBin(),
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-vn",
      "-sn",
      "-dn",
      "-c:a",
      "pcm_s16le",
      "-ar",
      String(DEEPGRAM_FLUX_SAMPLE_RATE),
      "-ac",
      "1",
      "-f",
      "s16le",
      pcmPath,
    ],
    {
      input: sourceBuffer,
      maxOutputBytes: 64 * 1024,
      signal: decodeSignal,
      terminateOnOutputError: true,
      timeoutMs: decodeTimeoutMs,
    },
  );
  if (decodeResult.termination !== "exit" || decodeResult.code !== 0) {
    const detail = decodeResult.stderr.toString("utf8").trim();
    throw new Error(
      `Audio transcription failed: ffmpeg ${decodeResult.termination}${detail ? `: ${detail}` : ""}`,
      { cause: decodeResult.error },
    );
  }
  await using pcm = await open(pcmPath, "r");
  if ((await pcm.stat()).size === 0) {
    throw new Error("Audio transcription failed: decoded audio is empty");
  }

  const baseUrl = params.requestConfig.baseUrl;
  const language = params.request.language;
  const model = params.model;
  const queryOptions = params.request.query;
  const url = URL.parse(baseUrl);
  if (!url) {
    throw new Error("Invalid Deepgram baseUrl: value is not a valid URL");
  }
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(
      `Invalid Deepgram baseUrl: unsupported scheme "${url.protocol}" (expected http, https, ws, or wss)`,
    );
  }
  const basePath = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${basePath ? basePath.replace(/\/v1$/u, "/v2") : "/v2"}/listen`;
  url.search = "";
  url.searchParams.set("model", model);
  url.searchParams.set("encoding", "linear16");
  url.searchParams.set("sample_rate", String(DEEPGRAM_FLUX_SAMPLE_RATE));
  // Deepgram's v2 contract permits language hints only on its multilingual model.
  const query = {
    ...queryOptions,
    language_hint:
      model === "flux-general-multi"
        ? (queryOptions?.language_hint ?? (language?.trim() || undefined))
        : undefined,
  };
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && DEEPGRAM_FLUX_QUERY_KEYS.has(key)) {
      setDeepgramQueryParam(url.searchParams, key, value);
    }
  }
  const socketUrl = url.toString();
  const timeoutMs = resolveTimeoutMs();
  const socket = await openProviderWebSocket({
    allowPrivateNetwork: params.requestConfig.allowPrivateNetwork,
    baseUrl: params.requestConfig.baseUrl,
    dispatcherPolicy: params.requestConfig.dispatcherPolicy,
    headers: params.requestConfig.headers,
    maxPayloadBytes: DEEPGRAM_FLUX_MAX_MESSAGE_BYTES,
    signal: params.request.signal,
    timeoutMs,
    trustConfiguredBaseUrlOrigin: params.requestConfig.trustConfiguredBaseUrlOrigin,
    url: socketUrl,
  });

  const transcript = await new Promise<string>((resolve, reject) => {
    const finalizedTurns: string[] = [];
    let finalizedTranscriptBytes = 0;
    let lastPartial = "";
    let settled = false;
    let closeStreamSent = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (outcome: { error?: Error; text?: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      timer = undefined;
      if (outcome.error) {
        reject(outcome.error);
      } else {
        resolve(outcome.text ?? "");
      }
    };
    socket.on("open", () => {
      void (async () => {
        try {
          const frame = Buffer.alloc(DEEPGRAM_FLUX_AUDIO_CHUNK_BYTES);
          for (;;) {
            if (settled) {
              return;
            }
            const { bytesRead } = await pcm.read(frame);
            if (bytesRead === 0 || settled) {
              break;
            }
            await sendSocketFrame(socket, frame.subarray(0, bytesRead));
          }
          if (settled) {
            return;
          }
          await sendSocketFrame(socket, JSON.stringify({ type: "CloseStream" }));
          closeStreamSent = true;
        } catch (error) {
          settle({
            error: new Error(
              `Audio transcription failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          });
        }
      })();
    });

    socket.on("message", (data) => {
      try {
        const event = readFluxEvent(data);
        if (event.type === "Error" || event.type === "error") {
          settle({
            error: new Error(`Audio transcription failed: ${readFluxErrorDetail(event)}`),
          });
          return;
        }
        if (event.type !== "TurnInfo") {
          return;
        }
        // Silence is a stream without turns; a turn without transcript text is malformed.
        if (typeof event.transcript !== "string") {
          throw new Error("Audio transcription response missing transcript");
        }
        if (event.event === "EndOfTurn") {
          finalizedTranscriptBytes += Buffer.byteLength(event.transcript, "utf8");
          finalizedTurns.push(event.transcript);
          lastPartial = "";
        } else {
          lastPartial = event.transcript;
        }
        if (
          finalizedTranscriptBytes + Buffer.byteLength(lastPartial, "utf8") >
          DEEPGRAM_FLUX_MAX_TRANSCRIPT_BYTES
        ) {
          settle({ error: new Error("Audio transcription failed: transcript exceeds size limit") });
        }
      } catch (error) {
        settle({ error: error instanceof Error ? error : new Error(String(error)) });
      }
    });

    socket.on("error", (error) => {
      settle({ error: new Error(`Audio transcription failed: ${error.message}`) });
    });

    socket.on("close", (code, reason) => {
      if (!closeStreamSent) {
        settle({ error: new Error("Audio transcription failed: Flux closed before flush") });
        return;
      }
      if (code !== 1000 && code !== 1005) {
        const detail = reason.toString().trim();
        settle({
          error: new Error(
            `Audio transcription failed: Flux closed abnormally (code ${code}${detail ? `: ${detail}` : ""})`,
          ),
        });
        return;
      }
      settle({
        text: [...finalizedTurns, lastPartial]
          .map((part) => part.trim())
          .filter(Boolean)
          .join(" "),
      });
    });
    // Connection preparation consumed part of the original operation budget.
    // Register handlers first so an exhausted budget still closes the socket safely.
    timer = setTimeout(
      () => settle({ error: new Error("Deepgram Flux transcription timed out") }),
      resolveTimeoutMs(),
    );
  }).finally(() => socket.terminate());

  // A clean close after flush without turns is silence; the media runner skips it.
  return { text: transcript, model: params.model };
}
