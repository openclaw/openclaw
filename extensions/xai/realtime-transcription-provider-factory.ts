import type { PluginCapabilityCatalogHostContext } from "openclaw/plugin-sdk/plugin-entry";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription-session";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createXaiRealtimeTranscriptionProviderMetadata,
  normalizeXaiRealtimeTranscriptionProviderConfig,
} from "./capability-provider-metadata-factory.js";
import { normalizeXaiRealtimeBaseUrl } from "./realtime-voice-config.js";
import { xaiUserAgentHeaderFor } from "./src/xai-user-agent.js";

function readErrorDetail(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const record = isRecord(value) ? value : undefined;
  const message = normalizeOptionalString(record?.message);
  const code = normalizeOptionalString(record?.code);
  return message ?? code ?? "xAI realtime transcription error";
}

export function buildXaiRealtimeTranscriptionProvider(
  runtime: Pick<
    PluginCapabilityCatalogHostContext,
    | "isProviderAuthProfileConfigured"
    | "isProviderAuthProfileConfiguredAsync"
    | "resolveApiKeyForProvider"
    | "createRealtimeTranscriptionWebSocketSession"
  >,
): RealtimeTranscriptionProviderPlugin {
  return {
    ...createXaiRealtimeTranscriptionProviderMetadata(runtime),
    createSession: (req) => {
      const config = normalizeXaiRealtimeTranscriptionProviderConfig(req.providerConfig);
      const baseUrl = normalizeXaiRealtimeBaseUrl(config.baseUrl);
      const callbacks = { ...req };
      let lastTranscript: string | undefined;
      let speechStarted = false;
      let lockedTranscript = "";
      const emitTranscript = (text: string) => {
        lockedTranscript = "";
        speechStarted = false;
        if (text === lastTranscript) {
          return;
        }
        lastTranscript = text;
        callbacks.onTranscript?.(text);
      };

      return runtime.createRealtimeTranscriptionWebSocketSession<{
        type?: string;
        text?: string;
        transcript?: string;
        is_final?: boolean;
        speech_final?: boolean;
        error?: unknown;
        message?: string;
      }>({
        providerId: "xai",
        callbacks,
        url: () => {
          const url = new URL(baseUrl);
          url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
          url.pathname = `${url.pathname.replace(/\/+$/, "")}/stt`;
          url.searchParams.set("sample_rate", String(config.sampleRate ?? 8000));
          url.searchParams.set("encoding", config.encoding ?? "mulaw");
          url.searchParams.set("interim_results", String(config.interimResults ?? true));
          url.searchParams.set("endpointing", String(config.endpointingMs ?? 800));
          if (config.language) {
            url.searchParams.set("language", config.language);
          }
          return url.toString();
        },
        // createSession stays synchronous; resolve credentials for each (re)connect.
        headers: async () => {
          const direct =
            normalizeOptionalString(config.apiKey) ??
            normalizeOptionalString(process.env.XAI_API_KEY);
          const apiKey =
            direct ??
            normalizeOptionalString(
              (await runtime.resolveApiKeyForProvider({ provider: "xai", cfg: req.cfg }))?.apiKey,
            );
          if (!apiKey) {
            throw new Error(
              "xAI credentials missing for realtime STT. Sign in with `openclaw onboard --auth-choice xai-oauth`, or run `openclaw onboard --auth-choice xai-api-key`, or set XAI_API_KEY.",
            );
          }
          return { Authorization: `Bearer ${apiKey}`, ...xaiUserAgentHeaderFor(baseUrl) };
        },
        connectTimeoutMs: 10_000,
        closeTimeoutMs: 5_000,
        maxReconnectAttempts: 5,
        reconnectDelayMs: 1000,
        maxQueuedBytes: 2 * 1024 * 1024,
        connectTimeoutMessage: "xAI realtime transcription connection timeout",
        connectClosedBeforeReadyMessage:
          "xAI realtime transcription connection closed before ready",
        reconnectLimitMessage: "xAI realtime transcription reconnect limit reached",
        onOpen: () => {
          // A replacement stream cannot finalize the previous stream's locked chunks.
          if (lockedTranscript) {
            emitTranscript(lockedTranscript);
          }
          speechStarted = false;
          lastTranscript = undefined;
        },
        sendAudio: (audio, transport) => {
          transport.sendBinary(audio);
        },
        onClose: (transport) => {
          transport.sendJson({ type: "audio.done" });
        },
        onMessage: (event, transport) => {
          if (event.type === "transcript.created") {
            transport.markReady();
            return;
          }
          if (!transport.isReady() && event.type === "error") {
            transport.failConnect(new Error(readErrorDetail(event.error ?? event.message)));
            return;
          }
          switch (event.type) {
            case "transcript.partial": {
              const text = normalizeOptionalString(event.text ?? event.transcript);
              if (!text) {
                return;
              }
              if (!speechStarted) {
                // Dedupe final/terminal echoes within one utterance, not identical later turns.
                lastTranscript = undefined;
                speechStarted = true;
                callbacks.onSpeechStart?.();
              }
              if (event.is_final && event.speech_final) {
                // xAI already stitches every chunk into the utterance final.
                emitTranscript(text);
                return;
              }
              const partial = lockedTranscript ? `${lockedTranscript} ${text}` : text;
              if (event.is_final) {
                lockedTranscript = partial;
              }
              callbacks.onPartial?.(partial);
              return;
            }
            case "transcript.done": {
              const text = normalizeOptionalString(event.text ?? event.transcript);
              if (text) {
                emitTranscript(text);
              }
              lockedTranscript = "";
              transport.closeNow();
              return;
            }
            case "error":
              callbacks.onError?.(new Error(readErrorDetail(event.error ?? event.message)));

            default:
          }
        },
      });
    },
  };
}
