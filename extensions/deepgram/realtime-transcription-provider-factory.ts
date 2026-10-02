import type { PluginCapabilityCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
  RealtimeTranscriptionWebSocketTransport,
} from "openclaw/plugin-sdk/realtime-transcription-session";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asOptionalRecord as readRecord,
  normalizeOptionalString,
  parseBooleanValue as readBoolean,
  parseFiniteNumber as readFiniteNumber,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { DEFAULT_DEEPGRAM_AUDIO_BASE_URL, DEFAULT_DEEPGRAM_AUDIO_MODEL } from "./audio.js";

type DeepgramRealtimeTranscriptionEncoding = "linear16" | "mulaw" | "alaw";

type DeepgramRealtimeTranscriptionProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  language?: string;
  sampleRate?: number;
  encoding?: DeepgramRealtimeTranscriptionEncoding;
  interimResults?: boolean;
  endpointingMs?: number;
  idleFlushMs?: number;
};

type DeepgramRealtimeTranscriptionSessionConfig = RealtimeTranscriptionSessionCreateRequest & {
  apiKey: string;
  baseUrl: string;
  model: string;
  sampleRate: number;
  encoding: DeepgramRealtimeTranscriptionEncoding;
  interimResults: boolean;
  endpointingMs: number;
  idleFlushMs: number;
  language?: string;
};

type DeepgramRealtimeTranscriptionEvent = {
  type?: string;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
    }>;
  };
  is_final?: boolean;
  speech_final?: boolean;
  from_finalize?: boolean;
  error?: unknown;
  message?: string;
};

const DEEPGRAM_REALTIME_DEFAULT_SAMPLE_RATE = 8000;
const DEEPGRAM_REALTIME_DEFAULT_ENCODING: DeepgramRealtimeTranscriptionEncoding = "mulaw";
const DEEPGRAM_REALTIME_DEFAULT_ENDPOINTING_MS = 800;
// Extra margin added on top of endpointing before the host asks Deepgram to
// finalize an idle turn. The request fires at endpointingMs + idleFlushMs after
// the transcript stops growing, so healthy audio always reaches speech_final
// first and cancels it; the request only goes out when endpointing stayed silent.
//
// Disabled by default. The timer keys on Results activity rather than on caller
// silence, so a provider that pauses Results mid-utterance could force a turn
// boundary while the caller is still speaking. Installations that actually see
// stalled turns opt in by setting idleFlushMs; nobody inherits the tradeoff on
// upgrade.
const DEEPGRAM_REALTIME_DEFAULT_IDLE_FLUSH_MS = 0;
// Bounded wait for Deepgram to answer an idle Finalize. A Finalize can produce
// no Results event at all. The turn still stays pending in that case - only the
// provider ends a turn - but the unanswered request is reported as a recoverable
// failure and a later Results event may ask again.
const DEEPGRAM_REALTIME_IDLE_FINALIZE_UNANSWERED_MS = 2_000;
const DEEPGRAM_REALTIME_IDLE_FINALIZE_UNANSWERED_MESSAGE =
  "Deepgram realtime idle finalize request went unanswered; turn left pending";
const DEEPGRAM_REALTIME_CONNECT_TIMEOUT_MS = 10_000;
const DEEPGRAM_REALTIME_CLOSE_TIMEOUT_MS = 5_000;
const DEEPGRAM_REALTIME_MAX_RECONNECT_ATTEMPTS = 5;
const DEEPGRAM_REALTIME_RECONNECT_DELAY_MS = 1000;
const DEEPGRAM_REALTIME_MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const DEEPGRAM_REALTIME_MAX_RETAINED_TRANSCRIPT_BYTES = 256 * 1024;
const DEEPGRAM_REALTIME_FINALIZE_FALLBACK_MS = DEEPGRAM_REALTIME_CLOSE_TIMEOUT_MS - 100;

function readNestedDeepgramConfig(rawConfig: RealtimeTranscriptionProviderConfig) {
  const raw = readRecord(rawConfig);
  const providers = readRecord(raw?.providers);
  return readRecord(providers?.deepgram ?? raw?.deepgram ?? raw) ?? {};
}

function normalizeDeepgramEncoding(
  value: unknown,
): DeepgramRealtimeTranscriptionEncoding | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "pcm" || normalized === "pcm_s16le" || normalized === "linear16") {
    return "linear16";
  }
  if (normalized === "ulaw" || normalized === "g711_ulaw" || normalized === "g711-mulaw") {
    return "mulaw";
  }
  if (normalized === "g711_alaw" || normalized === "g711-alaw") {
    return "alaw";
  }
  if (normalized === "mulaw" || normalized === "alaw") {
    return normalized;
  }
  throw new Error(`Invalid Deepgram realtime transcription encoding: ${normalized}`);
}

function normalizeDeepgramRealtimeBaseUrl(value?: string): string {
  const resolved = normalizeOptionalString(value ?? process.env.DEEPGRAM_BASE_URL);
  if (!resolved) {
    return DEFAULT_DEEPGRAM_AUDIO_BASE_URL;
  }
  let parsed: URL;
  try {
    parsed = new URL(resolved);
  } catch {
    throw new Error("Invalid Deepgram baseUrl: value is not a valid URL");
  }
  const { protocol } = parsed;
  if (protocol !== "http:" && protocol !== "https:" && protocol !== "ws:" && protocol !== "wss:") {
    // Endpoint URLs can contain userinfo or sensitive query values. Keep the
    // error actionable without echoing the configured value.
    throw new Error(
      `Invalid Deepgram baseUrl: unsupported scheme "${protocol}" (expected http, https, ws, or wss)`,
    );
  }
  return resolved;
}

function toDeepgramRealtimeWsUrl(config: DeepgramRealtimeTranscriptionSessionConfig): string {
  const url = new URL(normalizeDeepgramRealtimeBaseUrl(config.baseUrl));
  // Self-hosted Deepgram may explicitly use ws:// without TLS. Translate only
  // matching HTTP schemes so direct WebSocket endpoints keep their contract.
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/listen`;
  url.searchParams.set("model", config.model);
  url.searchParams.set("encoding", config.encoding);
  url.searchParams.set("sample_rate", String(config.sampleRate));
  url.searchParams.set("channels", "1");
  url.searchParams.set("interim_results", String(config.interimResults));
  url.searchParams.set("endpointing", String(config.endpointingMs));
  if (config.language) {
    url.searchParams.set("language", config.language);
  }
  return url.toString();
}

function normalizeProviderConfig(
  config: RealtimeTranscriptionProviderConfig,
): DeepgramRealtimeTranscriptionProviderConfig {
  const raw = readNestedDeepgramConfig(config);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw.apiKey,
      path: "plugins.entries.voice-call.config.streaming.providers.deepgram.apiKey",
    }),
    baseUrl: normalizeOptionalString(raw.baseUrl),
    model: normalizeOptionalString(raw.model ?? raw.sttModel),
    language: normalizeOptionalString(raw.language),
    sampleRate: readFiniteNumber(raw.sampleRate ?? raw.sample_rate),
    encoding: normalizeDeepgramEncoding(raw.encoding),
    interimResults: readBoolean(raw.interimResults ?? raw.interim_results),
    endpointingMs: readFiniteNumber(raw.endpointingMs ?? raw.endpointing ?? raw.silenceDurationMs),
    idleFlushMs: readFiniteNumber(raw.idleFlushMs),
  };
}

function readErrorDetail(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const record = readRecord(value);
  const message = normalizeOptionalString(record?.message);
  const code = normalizeOptionalString(record?.code);
  return message ?? code ?? "Deepgram realtime transcription error";
}

function createDeepgramRealtimeTranscriptionSession(
  config: DeepgramRealtimeTranscriptionSessionConfig,
  createRealtimeTranscriptionWebSocketSession: PluginCapabilityCatalogContext["createRealtimeTranscriptionWebSocketSession"],
): RealtimeTranscriptionSession {
  let speechStarted = false;
  let finalizedTranscript = "";
  let pendingPartial = "";
  let finalizeRequested = false;
  let finalizeFallbackFired = false;
  let finalizeFallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let idleFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  let idleFinalizeRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  // Effective transcript the idle backstop is already covering, either with a
  // pending timer or with a request already sent for it. Only text that moves
  // past this value may restart the timer.
  let idleFinalizeTranscript: string | undefined;
  let openedOnce = false;

  const collapseWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

  const joinTranscript = (left: string, right: string) =>
    collapseWhitespace(left && right ? `${left} ${right}` : left || right);

  const clearFinalizeFallback = () => {
    if (finalizeFallbackTimer) {
      clearTimeout(finalizeFallbackTimer);
      finalizeFallbackTimer = undefined;
    }
  };

  const clearIdleFinalize = () => {
    if (idleFinalizeTimer) {
      clearTimeout(idleFinalizeTimer);
      idleFinalizeTimer = undefined;
    }
    if (idleFinalizeRecoveryTimer) {
      clearTimeout(idleFinalizeRecoveryTimer);
      idleFinalizeRecoveryTimer = undefined;
    }
  };

  const reportIdleFinalizeError = (error: unknown) => {
    try {
      config.onError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // Error observers must not turn an idle finalize timer into an uncaught exception.
    }
  };

  /**
   * Ask Deepgram to finalize a turn whose transcript has stopped growing.
   *
   * Endpointing normally ends a turn: Deepgram notices the caller stop and
   * sends `speech_final`. When that never arrives mid-call the turn stalls with
   * no other terminal signal, the stream stays open, and the caller is answered
   * by nothing at all.
   *
   * The timer runs deliberately longer than Deepgram's own endpointing window,
   * so healthy audio always reaches `speech_final` first and cancels it. When it
   * does fire it sends `Finalize` instead of committing locally: Deepgram still
   * decides the turn boundary and answers with `from_finalize`, which the
   * existing terminal path commits. Turn completion stays provider-authoritative,
   * and a gap between provisional results never commits anything on its own.
   */
  const armIdleFinalize = (
    transport: RealtimeTranscriptionWebSocketTransport,
    effectiveTranscript: string,
  ) => {
    if (config.idleFlushMs <= 0) {
      return;
    }
    // Only a transcript that moved may postpone the request. Deepgram can
    // repeat the same nonterminal Results indefinitely, and re-arming on those
    // repeats would push the backstop out forever - reproducing the very stall
    // it exists to break. A repeat therefore leaves the pending timer, and any
    // request already sent for this text, exactly as they are.
    if (effectiveTranscript === idleFinalizeTranscript) {
      return;
    }
    idleFinalizeTranscript = effectiveTranscript;
    clearIdleFinalize();
    idleFinalizeTimer = setTimeout(() => {
      idleFinalizeTimer = undefined;
      if (!finalizedTranscript && !pendingPartial) {
        return;
      }
      // `sendJson` reports false before it ever touches the socket for a stale,
      // closed or superseded connection, and again for backpressure; a throw
      // leaves the frame unsent too. An unsent request can never draw a provider
      // terminal result, so nothing is pending on one: leave the flag clear so
      // the next Results event arms a fresh request, and do not start the
      // unanswered-request watchdog for a request that was never made.
      let requestSent = false;
      try {
        requestSent = transport.sendJson({ type: "Finalize" });
      } catch (error) {
        reportIdleFinalizeError(error);
      }
      if (!requestSent) {
        idleFinalizeTranscript = undefined;
        return;
      }
      // Deepgram may answer a Finalize with no Results event at all. Committing
      // here would invent a turn boundary the provider never gave: an
      // `is_final` segment is confirmed text, not a completed utterance, and
      // only `speech_final` or `from_finalize` ends a turn. While the call is
      // open the turn therefore stays pending; the unanswered request is
      // surfaced as a recoverable failure and the cleared coverage marker lets
      // a later Results event ask again. The close path still preserves
      // confirmed text at hangup.
      idleFinalizeRecoveryTimer = setTimeout(() => {
        idleFinalizeRecoveryTimer = undefined;
        idleFinalizeTranscript = undefined;
        if (!finalizedTranscript && !pendingPartial) {
          return;
        }
        reportIdleFinalizeError(new Error(DEEPGRAM_REALTIME_IDLE_FINALIZE_UNANSWERED_MESSAGE));
      }, DEEPGRAM_REALTIME_IDLE_FINALIZE_UNANSWERED_MS);
    }, config.endpointingMs + config.idleFlushMs);
  };

  const clearTurn = () => {
    clearFinalizeFallback();
    clearIdleFinalize();
    idleFinalizeTranscript = undefined;
    finalizedTranscript = "";
    pendingPartial = "";
    speechStarted = false;
  };

  const updateTurn = (
    nextFinalized: string,
    nextPartial: string,
    transport: RealtimeTranscriptionWebSocketTransport,
  ) => {
    const retainedBytes =
      Buffer.byteLength(nextFinalized, "utf8") + Buffer.byteLength(nextPartial, "utf8");
    if (retainedBytes > DEEPGRAM_REALTIME_MAX_RETAINED_TRANSCRIPT_BYTES) {
      clearTurn();
      config.onError?.(
        new Error(
          `Deepgram realtime retained transcript exceeded ${DEEPGRAM_REALTIME_MAX_RETAINED_TRANSCRIPT_BYTES} bytes`,
        ),
      );
      transport.closeNow();
      return false;
    }
    finalizedTranscript = nextFinalized;
    pendingPartial = nextPartial;
    return true;
  };

  const flushTurn = (includePartial = true) => {
    const full = joinTranscript(finalizedTranscript, includePartial ? pendingPartial : "");
    clearTurn();
    if (full) {
      config.onTranscript?.(full);
    }
  };

  const handleEvent = (
    event: DeepgramRealtimeTranscriptionEvent,
    transport: RealtimeTranscriptionWebSocketTransport,
  ) => {
    switch (event.type) {
      case "Results": {
        if (finalizeFallbackFired) {
          return;
        }
        const text = normalizeOptionalString(event.channel?.alternatives?.[0]?.transcript);
        if (text && !speechStarted) {
          speechStarted = true;
          config.onSpeechStart?.();
        }
        if (event.speech_final || event.from_finalize) {
          const nextFinalized = text
            ? joinTranscript(finalizedTranscript, text)
            : finalizedTranscript;
          if (!updateTurn(nextFinalized, "", transport)) {
            return;
          }
          flushTurn();
          return;
        }
        if (!text) {
          return;
        }
        const nextFinalized = event.is_final
          ? joinTranscript(finalizedTranscript, text)
          : finalizedTranscript;
        if (!updateTurn(nextFinalized, event.is_final ? "" : text, transport)) {
          return;
        }
        const effective = event.is_final ? nextFinalized : joinTranscript(nextFinalized, text);
        armIdleFinalize(transport, effective);
        config.onPartial?.(effective);
        return;
      }
      case "SpeechStarted":
        speechStarted = true;
        config.onSpeechStart?.();
        return;
      case "Error":
      case "error":
        config.onError?.(new Error(readErrorDetail(event.error ?? event.message)));

      default:
    }
  };

  return createRealtimeTranscriptionWebSocketSession<DeepgramRealtimeTranscriptionEvent>({
    providerId: "deepgram",
    callbacks: config,
    url: () => toDeepgramRealtimeWsUrl(config),
    headers: { Authorization: `Token ${config.apiKey}` },
    readyOnOpen: true,
    connectTimeoutMs: DEEPGRAM_REALTIME_CONNECT_TIMEOUT_MS,
    closeTimeoutMs: DEEPGRAM_REALTIME_CLOSE_TIMEOUT_MS,
    maxReconnectAttempts: DEEPGRAM_REALTIME_MAX_RECONNECT_ATTEMPTS,
    reconnectDelayMs: DEEPGRAM_REALTIME_RECONNECT_DELAY_MS,
    maxQueuedBytes: DEEPGRAM_REALTIME_MAX_QUEUED_BYTES,
    connectTimeoutMessage: "Deepgram realtime transcription connection timeout",
    connectClosedBeforeReadyMessage:
      "Deepgram realtime transcription connection closed before ready",
    reconnectLimitMessage: "Deepgram realtime transcription reconnect limit reached",
    onOpen: () => {
      if (openedOnce) {
        // The replacement stream cannot replay confirmed text from the old
        // connection. Emit it as an interrupted turn, but discard its partial tail.
        flushTurn(false);
      } else {
        openedOnce = true;
        clearTurn();
      }
      finalizeRequested = false;
      finalizeFallbackFired = false;
      idleFinalizeTranscript = undefined;
    },
    sendAudio: (audio, transport) => {
      transport.sendBinary(audio);
    },
    onClose: (transport) => {
      if (finalizeRequested) {
        return;
      }
      finalizeRequested = true;
      if (finalizedTranscript) {
        // Finalize may produce no Results event when Deepgram has no buffered
        // audio left. Preserve already-finalized text before core force-closes.
        finalizeFallbackTimer = setTimeout(() => {
          finalizeFallbackTimer = undefined;
          finalizeFallbackFired = true;
          try {
            flushTurn(false);
          } catch (error) {
            try {
              config.onError?.(error instanceof Error ? error : new Error(String(error)));
            } catch {
              // Error observers must not turn close fallback into an uncaught timer exception.
            }
          }
        }, DEEPGRAM_REALTIME_FINALIZE_FALLBACK_MS);
      }
      transport.sendJson({ type: "Finalize" });
    },
    onMessage: handleEvent,
  });
}

export function buildDeepgramRealtimeTranscriptionProvider({
  createRealtimeTranscriptionWebSocketSession,
}: Pick<
  PluginCapabilityCatalogContext,
  "createRealtimeTranscriptionWebSocketSession"
>): RealtimeTranscriptionProviderPlugin {
  return {
    id: "deepgram",
    label: "Deepgram Realtime Transcription",
    aliases: ["deepgram-realtime", "nova-3-streaming"],
    defaultModel: DEFAULT_DEEPGRAM_AUDIO_MODEL,
    autoSelectOrder: 35,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) =>
      Boolean(normalizeProviderConfig(providerConfig).apiKey || process.env.DEEPGRAM_API_KEY),
    createSession: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      const apiKey = config.apiKey || process.env.DEEPGRAM_API_KEY;
      if (!apiKey) {
        throw new Error("Deepgram API key missing");
      }
      return createDeepgramRealtimeTranscriptionSession(
        {
          ...req,
          apiKey,
          baseUrl: normalizeDeepgramRealtimeBaseUrl(config.baseUrl),
          model: config.model ?? DEFAULT_DEEPGRAM_AUDIO_MODEL,
          sampleRate: config.sampleRate ?? DEEPGRAM_REALTIME_DEFAULT_SAMPLE_RATE,
          encoding: config.encoding ?? DEEPGRAM_REALTIME_DEFAULT_ENCODING,
          interimResults: config.interimResults ?? true,
          endpointingMs: config.endpointingMs ?? DEEPGRAM_REALTIME_DEFAULT_ENDPOINTING_MS,
          idleFlushMs: config.idleFlushMs ?? DEEPGRAM_REALTIME_DEFAULT_IDLE_FLUSH_MS,
          language: config.language,
        },
        createRealtimeTranscriptionWebSocketSession,
      );
    },
  };
}
