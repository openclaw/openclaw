import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";

const VOICE_DEBUG_ENABLED = !!process.env.VOICE_DEBUG;
const VOICE_DEBUG_LOG = VOICE_DEBUG_ENABLED
  ? path.join(os.homedir(), ".openclaw", "voice-debug.log")
  : null;
function voiceDebug(msg: string): void {
  if (!VOICE_DEBUG_ENABLED) return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  if (VOICE_DEBUG_LOG) {
    try { fs.appendFileSync(VOICE_DEBUG_LOG, line); } catch { /* ignore */ }
  }
  console.log(`[voice-debug] ${msg}`);
}
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/voice-call";
import { normalizeVoiceCallConfig, type VoiceCallConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import type { CallManager } from "./manager.js";
import type { MediaStreamConfig } from "./media-stream.js";
import { MediaStreamHandler } from "./media-stream.js";
import type { VoiceCallProvider } from "./providers/base.js";
import type { STTProvider } from "./providers/stt-openai-realtime.js";
import type { TelephonyTtsProvider } from "./telephony-tts.js";
import { OpenAIRealtimeSTTProvider } from "./providers/stt-openai-realtime.js";
import { DeepgramSTTProvider } from "./providers/stt-deepgram.js";
import type { TwilioProvider } from "./providers/twilio.js";
import type { NormalizedEvent, WebhookContext } from "./types.js";
import { startStaleCallReaper } from "./webhook/stale-call-reaper.js";

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

type WebhookResponsePayload = {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
};

function buildRequestUrl(
  requestUrl: string | undefined,
  requestHost: string | undefined,
  fallbackHost = "localhost",
): URL {
  return new URL(requestUrl ?? "/", `http://${requestHost ?? fallbackHost}`);
}

function normalizeWebhookResponse(parsed: {
  statusCode?: number;
  providerResponseHeaders?: Record<string, string>;
  providerResponseBody?: string;
}): WebhookResponsePayload {
  return {
    statusCode: parsed.statusCode ?? 200,
    headers: parsed.providerResponseHeaders,
    body: parsed.providerResponseBody ?? "OK",
  };
}

/**
 * HTTP server for receiving voice call webhooks from providers.
 * Supports WebSocket upgrades for media streams when streaming is enabled.
 */
export class VoiceCallWebhookServer {
  private server: http.Server | null = null;
  private listeningUrl: string | null = null;
  private config: VoiceCallConfig;
  private manager: CallManager;
  private provider: VoiceCallProvider;
  private coreConfig: CoreConfig | null;
  private stopStaleCallReaper: (() => void) | null = null;

  /** Media stream handler for bidirectional audio (when streaming enabled) */
  private mediaStreamHandler: MediaStreamHandler | null = null;
  /** Telephony TTS provider for generating audio via external TTS (Cartesia, etc.) */
  private telephonyTtsProvider: TelephonyTtsProvider | null = null;
  /** Guard against double-processing call.answered events (synthetic + real webhook) */
  private answeredCalls = new Set<string>();
  /** Greeting text stashed from manager to speak via Cartesia instead of native TTS */
  private pendingGreetings = new Map<string, string>();

  constructor(
    config: VoiceCallConfig,
    manager: CallManager,
    provider: VoiceCallProvider,
    coreConfig?: CoreConfig,
  ) {
    this.config = normalizeVoiceCallConfig(config);
    this.manager = manager;
    this.provider = provider;
    this.coreConfig = coreConfig ?? null;

    // Initialize media stream handler if streaming is enabled
    if (this.config.streaming.enabled) {
      this.initializeMediaStreaming();
    }
  }

  /**
   * Get the media stream handler (for wiring to provider).
   */
  getMediaStreamHandler(): MediaStreamHandler | null {
    return this.mediaStreamHandler;
  }

  /**
   * Set the telephony TTS provider for generating audio via external TTS.
   * When set, speakToCall will use this instead of native provider TTS.
   */
  setTelephonyTtsProvider(provider: TelephonyTtsProvider): void {
    this.telephonyTtsProvider = provider;
  }

  /**
   * Initialize media streaming with the configured STT provider.
   */
  private initializeMediaStreaming(): void {
    const streaming = this.config.streaming;

    let sttProvider: STTProvider;

    if (streaming.sttProvider === "deepgram") {
      const apiKey = streaming.deepgramApiKey ?? process.env.DEEPGRAM_API_KEY;
      if (!apiKey) {
        console.warn("[voice-call] Streaming enabled with deepgram but no Deepgram API key found");
        return;
      }
      sttProvider = new DeepgramSTTProvider({
        apiKey,
        model: streaming.deepgramModel,
        endpointingMs: streaming.silenceDurationMs,
        language: "en",
      });
      console.log(`[voice-call] STT provider: deepgram (model: ${streaming.deepgramModel})`);
    } else {
      // Default: openai-realtime
      const apiKey = streaming.openaiApiKey ?? process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.warn("[voice-call] Streaming enabled but no OpenAI API key found");
        return;
      }
      sttProvider = new OpenAIRealtimeSTTProvider({
        apiKey,
        model: streaming.sttModel,
        silenceDurationMs: streaming.silenceDurationMs,
        vadThreshold: streaming.vadThreshold,
      });
      console.log(`[voice-call] STT provider: openai-realtime (model: ${streaming.sttModel})`);
    }

    const streamConfig: MediaStreamConfig = {
      sttProvider,
      preStartTimeoutMs: streaming.preStartTimeoutMs,
      maxPendingConnections: streaming.maxPendingConnections,
      maxPendingConnectionsPerIp: streaming.maxPendingConnectionsPerIp,
      maxConnections: streaming.maxConnections,
      shouldAcceptStream: ({ callId, token }) => {
        const call = this.manager.getCallByProviderCallId(callId);
        if (!call) {
          return false;
        }
        if (this.provider.name === "twilio") {
          const twilio = this.provider as TwilioProvider;
          if (!twilio.isValidStreamToken(callId, token)) {
            console.warn(`[voice-call] Rejecting media stream: invalid token for ${callId}`);
            return false;
          }
        }
        return true;
      },
      onTranscript: (providerCallId, transcript) => {
        console.log(`[voice-call] Transcript for ${providerCallId}: ${transcript}`);

        // Clear TTS queue on barge-in (user started speaking, interrupt current playback)
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).clearTtsQueue(providerCallId);
        }

        // Look up our internal call ID from the provider call ID
        const call = this.manager.getCallByProviderCallId(providerCallId);
        if (!call) {
          console.warn(`[voice-call] No active call found for provider ID: ${providerCallId}`);
          return;
        }

        // Create a speech event and process it through the manager
        const event: NormalizedEvent = {
          id: `stream-transcript-${Date.now()}`,
          type: "call.speech",
          callId: call.callId,
          providerCallId,
          timestamp: Date.now(),
          transcript,
          isFinal: true,
        };
        this.manager.processEvent(event);

        // Auto-respond in conversation mode (inbound always, outbound if mode is conversation)
        const callMode = call.metadata?.mode as string | undefined;
        const shouldRespond = call.direction === "inbound" || callMode === "conversation";
        if (shouldRespond) {
          this.handleInboundResponse(call.callId, transcript).catch((err) => {
            console.warn(`[voice-call] Failed to auto-respond:`, err);
          });
        }
      },
      onSpeechStart: (providerCallId) => {
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).clearTtsQueue(providerCallId);
        }
      },
      onPartialTranscript: (callId, partial) => {
        console.log(`[voice-call] Partial for ${callId}: ${partial}`);
      },
      onConnect: (callId, streamSid) => {
        console.log(`[voice-call] Media stream connected: ${callId} -> ${streamSid}`);
        // Register stream with provider for TTS routing
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).registerCallStream(callId, streamSid);
        }

        // Speak initial message if one was provided when call was initiated
        // Use setTimeout to allow stream setup to complete
        setTimeout(() => {
          this.manager.speakInitialMessage(callId).catch((err) => {
            console.warn(`[voice-call] Failed to speak initial message:`, err);
          });
        }, 500);
      },
      onDisconnect: (callId) => {
        console.log(`[voice-call] Media stream disconnected: ${callId}`);
        // Auto-end call when media stream disconnects to prevent stuck calls.
        // Without this, calls can remain active indefinitely after the stream closes.
        const disconnectedCall = this.manager.getCallByProviderCallId(callId);
        if (disconnectedCall) {
          console.log(
            `[voice-call] Auto-ending call ${disconnectedCall.callId} on stream disconnect`,
          );
          void this.manager.endCall(disconnectedCall.callId).catch((err) => {
            console.warn(`[voice-call] Failed to auto-end call ${disconnectedCall.callId}:`, err);
          });
        }
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).unregisterCallStream(callId);
        }
      },
    };

    this.mediaStreamHandler = new MediaStreamHandler(streamConfig);
    console.log("[voice-call] Media streaming initialized");
  }

  /**
   * Start the webhook server.
   * Idempotent: returns immediately if the server is already listening.
   */
  async start(): Promise<string> {
    const { port, bind, path: webhookPath } = this.config.serve;
    const streamPath = this.config.streaming.streamPath;

    // Guard: if a server is already listening, return the existing URL.
    // This prevents EADDRINUSE when start() is called more than once on the
    // same instance (e.g. during config hot-reload or concurrent ensureRuntime).
    if (this.server?.listening) {
      return this.listeningUrl ?? this.resolveListeningUrl(bind, webhookPath);
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res, webhookPath).catch((err) => {
          console.error("[voice-call] Webhook error:", err);
          res.statusCode = 500;
          res.end("Internal Server Error");
        });
      });

      // Handle WebSocket upgrades for media streams
      if (this.mediaStreamHandler) {
        this.server.on("upgrade", (request, socket, head) => {
          const path = this.getUpgradePathname(request);
          if (path === streamPath) {
            console.log("[voice-call] WebSocket upgrade for media stream");
            this.mediaStreamHandler?.handleUpgrade(request, socket, head);
          } else {
            socket.destroy();
          }
        });
      }

      this.server.on("error", reject);

      this.server.listen(port, bind, () => {
        const url = this.resolveListeningUrl(bind, webhookPath);
        this.listeningUrl = url;
        console.log(`[voice-call] Webhook server listening on ${url}`);
        if (this.mediaStreamHandler) {
          const address = this.server?.address();
          const actualPort =
            address && typeof address === "object" ? address.port : this.config.serve.port;
          console.log(
            `[voice-call] Media stream WebSocket on ws://${bind}:${actualPort}${streamPath}`,
          );
        }
        resolve(url);

        // Start the stale call reaper if configured
        this.stopStaleCallReaper = startStaleCallReaper({
          manager: this.manager,
          staleCallReaperSeconds: this.config.staleCallReaperSeconds,
        });
      });
    });
  }

  /**
   * Stop the webhook server.
   */
  async stop(): Promise<void> {
    if (this.stopStaleCallReaper) {
      this.stopStaleCallReaper();
      this.stopStaleCallReaper = null;
    }
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          this.listeningUrl = null;
          resolve();
        });
      } else {
        this.listeningUrl = null;
        resolve();
      }
    });
  }

  private resolveListeningUrl(bind: string, webhookPath: string): string {
    const address = this.server?.address();
    if (address && typeof address === "object") {
      const host = address.address && address.address.length > 0 ? address.address : bind;
      const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      return `http://${normalizedHost}:${address.port}${webhookPath}`;
    }
    return `http://${bind}:${this.config.serve.port}${webhookPath}`;
  }

  /**
   * Derive the public WebSocket URL for audio streaming.
   * Telnyx needs to connect TO this URL to fork audio.
   * Constructed from publicUrl (replacing scheme and path).
   */
  private getStreamWebSocketUrl(): string | null {
    const publicUrl = this.config.publicUrl;
    if (!publicUrl) {
      return null;
    }
    try {
      const parsed = new URL(publicUrl);
      // Switch to wss:// (or ws:// for http)
      parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
      parsed.pathname = this.config.streaming.streamPath || "/voice/stream";
      return parsed.toString();
    } catch {
      return null;
    }
  }

  private getUpgradePathname(request: http.IncomingMessage): string | null {
    try {
      return buildRequestUrl(request.url, request.headers.host).pathname;
    } catch {
      return null;
    }
  }

  private normalizeWebhookPathForMatch(pathname: string): string {
    const trimmed = pathname.trim();
    if (!trimmed) {
      return "/";
    }
    const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    if (prefixed === "/") {
      return prefixed;
    }
    return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
  }

  private isWebhookPathMatch(requestPath: string, configuredPath: string): boolean {
    return (
      this.normalizeWebhookPathForMatch(requestPath) ===
      this.normalizeWebhookPathForMatch(configuredPath)
    );
  }

  /**
   * Handle incoming HTTP request.
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    webhookPath: string,
  ): Promise<void> {
    const payload = await this.runWebhookPipeline(req, webhookPath);
    voiceDebug(`RESPONSE: ${payload.statusCode} ${payload.body.slice(0, 100)}`);
    this.writeWebhookResponse(res, payload);
  }

  private async runWebhookPipeline(
    req: http.IncomingMessage,
    webhookPath: string,
  ): Promise<WebhookResponsePayload> {
    const url = buildRequestUrl(req.url, req.headers.host);
    voiceDebug(`HTTP ${req.method} ${url.pathname} from=${req.socket.remoteAddress}`);

    if (url.pathname === "/voice/hold-music") {
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/xml" },
        body: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">All agents are currently busy. Please hold.</Say>
  <Play loop="0">https://s3.amazonaws.com/com.twilio.music.classical/BusyStrings.mp3</Play>
</Response>`,
      };
    }

    if (!this.isWebhookPathMatch(url.pathname, webhookPath)) {
      return { statusCode: 404, body: "Not Found" };
    }

    if (req.method !== "POST") {
      return { statusCode: 405, body: "Method Not Allowed" };
    }

    let body = "";
    try {
      body = await this.readBody(req, MAX_WEBHOOK_BODY_BYTES);
    } catch (err) {
      if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
        return { statusCode: 413, body: "Payload Too Large" };
      }
      if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
        return { statusCode: 408, body: requestBodyErrorToText("REQUEST_BODY_TIMEOUT") };
      }
      throw err;
    }

    const ctx: WebhookContext = {
      headers: req.headers as Record<string, string | string[] | undefined>,
      rawBody: body,
      url: url.toString(),
      method: "POST",
      query: Object.fromEntries(url.searchParams),
      remoteAddress: req.socket.remoteAddress ?? undefined,
    };

    // Log raw Telnyx payload when VOICE_DEBUG is enabled
    if (VOICE_DEBUG_ENABLED && this.provider.name === "telnyx") {
      try {
        const payload = JSON.parse(ctx.rawBody);
        const evt = payload?.data?.event_type || "unknown";
        const pl = payload?.data?.payload || {};
        voiceDebug(`RAW WEBHOOK: event=${evt} payload_keys=${Object.keys(pl).join(",")}`);
        if (evt === "unknown") {
          voiceDebug(`RAW UNKNOWN BODY: ${ctx.rawBody.slice(0, 1000)}`);
        }
        if (evt === "call.transcription") {
          voiceDebug(`RAW TRANSCRIPTION: ${JSON.stringify(pl).slice(0, 500)}`);
        }
      } catch { /* ignore */ }
    }

    const verification = this.provider.verifyWebhook(ctx);
    if (!verification.ok) {
      voiceDebug(`VERIFICATION FAILED: ${verification.reason}`);
      return { statusCode: 401, body: "Unauthorized" };
    }
    if (!verification.verifiedRequestKey) {
      voiceDebug(`VERIFICATION OK but no request key`);
      return { statusCode: 401, body: "Unauthorized" };
    }

    const parsed = this.provider.parseWebhookEvent(ctx, {
      verifiedRequestKey: verification.verifiedRequestKey,
    });

    if (verification.isReplay) {
      console.warn("[voice-call] Replay detected; skipping event side effects");
    } else {
      this.processParsedEvents(parsed.events);
    }

    return normalizeWebhookResponse(parsed);
  }

  private processParsedEvents(events: NormalizedEvent[]): void {
    voiceDebug(`processParsedEvents: ${events.length} events, provider=${this.provider.name}`);

    // When we have external TTS (Cartesia), suppress the manager's native greeting
    // so we can speak it ourselves via speakToCall (which routes through Cartesia).
    // We stash the greeting text per-call and deliver it in handleTelnyxPostEvent.
    if (this.telephonyTtsProvider && this.provider.name === "telnyx") {
      for (const event of events) {
        if (event.type === "call.answered") {
          const pcid = event.providerCallId || event.callId;
          const call = this.manager.getCall(event.callId) ??
            this.manager.getCallByProviderCallId(pcid);
          if (call?.metadata?.initialMessage) {
            this.pendingGreetings.set(call.callId, call.metadata.initialMessage as string);
            delete call.metadata.initialMessage;
          }
        }
      }
    }

    for (const event of events) {
      voiceDebug(`  event: type=${event.type} callId=${event.callId?.slice(0,12)} dir=${event.direction || "?"}`);
      try {
        this.manager.processEvent(event);
      } catch (err) {
        console.error(`[voice-call] Error processing event ${event.type}:`, err);
      }
    }

    // Post-processing: handle provider-specific inbound behaviors for providers
    // that use event-driven call control (Telnyx) rather than response markup (Twilio TwiML).
    if (this.provider.name === "telnyx") {
      voiceDebug(`Running Telnyx post-event processing for ${events.length} events`);
      for (const event of events) {
        this.handleTelnyxPostEvent(event);
      }
    }
  }

  /**
   * Handle Telnyx-specific post-event actions for the non-streaming inbound path.
   * Telnyx is event-driven (unlike Twilio's TwiML response model), so we must
   * explicitly answer calls, start transcription, and trigger AI responses.
   */
  private handleTelnyxPostEvent(event: NormalizedEvent): void {
    // Auto-answer inbound calls
    if (event.type === "call.initiated" && event.direction === "inbound") {
      // After processEvent, event.callId may be the internal UUID; use providerCallId or
      // fall back to looking up the call record for the provider ID
      const providerCallId =
        event.providerCallId ||
        this.manager.getCall(event.callId)?.providerCallId ||
        event.callId;
      voiceDebug(`call.initiated inbound: providerCallId=${providerCallId} eventCallId=${event.callId} eventProviderCallId=${event.providerCallId} hasAnswerCall=${!!this.provider.answerCall}`);
      if (this.provider.answerCall && providerCallId) {
        voiceDebug(`Answering inbound call ${providerCallId}`);
        void this.provider
          .answerCall({ callId: event.callId, providerCallId })
          .then(() => {
            voiceDebug(`Answer call succeeded`);
            // Synthesize a call.answered event to trigger greeting + streaming
            // Telnyx sometimes doesn't deliver the call.answered webhook reliably
            const answeredEvent: NormalizedEvent = {
              id: `synth-answered-${Date.now()}`,
              type: "call.answered",
              callId: event.callId,
              providerCallId,
              timestamp: Date.now(),
            };
            voiceDebug(`Synthesizing call.answered event for ${providerCallId}`);
            this.handleTelnyxPostEvent(answeredEvent);
          })
          .catch((err) => {
            voiceDebug(`Answer call FAILED: ${err}`);
          });
      } else {
        voiceDebug(`Cannot answer: no answerCall method or no providerCallId`);
      }
      return;
    }

    // Start transcription/streaming after call is answered (inbound only)
    // Delay slightly to let the greeting TTS establish the audio path first
    if (event.type === "call.answered") {
      const providerCallId = event.providerCallId || event.callId;
      const call =
        this.manager.getCall(event.callId) ??
        this.manager.getCallByProviderCallId(providerCallId);
      // Guard: skip if we already processed answered for this call (synthetic + real webhook)
      const answerKey = call?.callId ?? providerCallId;
      if (this.answeredCalls.has(answerKey)) {
        voiceDebug(`Skipping duplicate call.answered for ${answerKey}`);
        return;
      }
      this.answeredCalls.add(answerKey);
      if (call?.direction === "inbound" && call.providerCallId) {
        const pcid = call.providerCallId;
        const cid = call.callId;

        // Speak greeting via Cartesia (grab from call record and clear so manager doesn't also speak it)
        const greetingText = this.pendingGreetings.get(cid) ||
          (typeof call.metadata?.initialMessage === "string" ? call.metadata.initialMessage.trim() : "");
        if (greetingText) {
          this.pendingGreetings.delete(cid);
          if (call.metadata) delete call.metadata.initialMessage;
          voiceDebug(`Speaking Cartesia greeting for ${cid}: "${greetingText}"`);
          void this.speakToCall(cid, pcid, greetingText).then(() => {
            voiceDebug(`Cartesia greeting delivered for ${cid}`);
          }).catch((err) => {
            voiceDebug(`Cartesia greeting failed: ${err}`);
          });
        }

        // Start transcription after greeting has time to establish audio path
        const startTranscription = () => {
          voiceDebug(`Starting transcription for ${cid} (provider: ${pcid})`);
          void this.provider
            .startListening({ callId: cid, providerCallId: pcid })
            .catch((err) => {
              voiceDebug(`Failed to start transcription: ${err}`);
            });
        };

        if (this.config.streaming.enabled && this.provider.startStreaming) {
          // Try streaming mode first, fall back to native transcription
          setTimeout(() => {
            const streamUrl = this.getStreamWebSocketUrl();
            if (!streamUrl) {
              voiceDebug(`Cannot start streaming: no public WebSocket URL available`);
              startTranscription();
              return;
            }
            voiceDebug(`Starting audio stream for ${cid} → ${streamUrl}`);
            void this.provider
              .startStreaming!({ providerCallId: pcid, streamUrl })
              .then(() => voiceDebug(`Audio streaming started for ${cid}`))
              .catch((err) => {
                voiceDebug(`Failed to start audio streaming: ${err}`);
                voiceDebug(`Falling back to native transcription for ${cid}`);
                startTranscription();
              });
          }, 2000);
        } else {
          // Native transcription mode
          setTimeout(() => {
            voiceDebug(`Starting transcription for ${cid} (provider: ${pcid})`);
            void this.provider
              .startListening({ callId: cid, providerCallId: pcid })
              .catch((err) => {
                voiceDebug(`Failed to start transcription: ${err}`);
              });
          }, 2000);
        }
      }
      return;
    }

    // Restart transcription after TTS finishes (Telnyx stops listening during speak).
    // Only needed for native transcription — streaming mode keeps audio fork active during speak.
    // Suppress Telnyx error 90054 ("transcription already in progress") — harmless race.
    if (event.type === "call.active") {
      // Streaming mode: audio fork stays active during speak, no restart needed
      if (this.config.streaming.enabled) {
        return;
      }
      const call =
        this.manager.getCall(event.callId) ??
        this.manager.getCallByProviderCallId(event.providerCallId || event.callId);
      if (call?.direction === "inbound" && call.providerCallId) {
        voiceDebug(`Speak ended — restarting transcription for ${call.callId}`);
        void this.provider
          .startListening({ callId: call.callId, providerCallId: call.providerCallId })
          .catch((err) => {
            const errStr = String(err);
            // 90054 = transcription already running — safe to ignore
            if (errStr.includes("90054")) {
              voiceDebug(`Transcription already active (90054) — OK`);
            } else {
              voiceDebug(`Failed to restart transcription: ${err}`);
            }
          });
      }
      return;
    }

    // Auto-respond to final speech transcripts (non-streaming conversation loop).
    // When streaming is enabled, transcripts come from the media stream onTranscript callback
    // (see initializeMediaStreaming), not from native provider transcription events.
    if (
      event.type === "call.speech" &&
      !this.config.streaming.enabled &&
      "isFinal" in event &&
      event.isFinal &&
      "transcript" in event
    ) {
      const transcript = event.transcript.trim();
      voiceDebug(`Speech event: callId=${event.callId} transcript="${transcript}"`);
      if (!transcript) {
        voiceDebug(`Ignoring empty transcript`);
        return;
      }
      // Look up call by internal ID first, then fall back to provider call ID
      const call =
        this.manager.getCall(event.callId) ??
        this.manager.getCallByProviderCallId(event.callId);
      voiceDebug(`Call lookup: found=${!!call} direction=${call?.direction} state=${call?.state} callId=${call?.callId}`);
      if (call?.direction === "inbound") {
        voiceDebug(`Triggering handleInboundResponse`);
        void this.handleInboundResponse(call.callId, transcript).catch((err) => {
          voiceDebug(`handleInboundResponse THREW: ${err}`);
        });
      }
    }
  }

  private writeWebhookResponse(res: http.ServerResponse, payload: WebhookResponsePayload): void {
    res.statusCode = payload.statusCode;
    if (payload.headers) {
      for (const [key, value] of Object.entries(payload.headers)) {
        res.setHeader(key, value);
      }
    }
    res.end(payload.body);
  }

  /**
   * Read request body as string with timeout protection.
   */
  private readBody(
    req: http.IncomingMessage,
    maxBytes: number,
    timeoutMs = 30_000,
  ): Promise<string> {
    return readRequestBodyWithLimit(req, { maxBytes, timeoutMs });
  }

  /**
   * Handle auto-response for inbound calls using the agent system.
   * Supports tool calling for richer voice interactions.
   */
  private async handleInboundResponse(callId: string, userMessage: string): Promise<void> {
    console.log(`[voice-call] Auto-responding to inbound call ${callId}: "${userMessage}"`);

    // Get call context for conversation history
    const call = this.manager.getCall(callId);
    if (!call) {
      console.warn(`[voice-call] Call ${callId} not found for auto-response`);
      return;
    }

    voiceDebug(`handleInboundResponse START callId=${callId} msg="${userMessage}"`);

    if (!this.coreConfig) {
      voiceDebug(`coreConfig is NULL - speaking fallback`);
      await this.manager.speak(callId, "I'm sorry, I'm having a technical issue. Please try again later or I can transfer you to our team.");
      return;
    }

    try {
      const { generateVoiceResponse } = await import("./response-generator.js");

      voiceDebug(`Calling generateVoiceResponse with model=${this.config.responseModel}...`);
      const result = await generateVoiceResponse({
        voiceConfig: this.config,
        coreConfig: this.coreConfig,
        callId,
        from: call.from,
        transcript: call.transcript,
        userMessage,
      });

      voiceDebug(`generateVoiceResponse returned: text=${result.text ? `"${result.text.slice(0,80)}"` : "null"} error=${result.error || "none"}`);

      if (result.error) {
        voiceDebug(`Response error - speaking fallback`);
        await this.manager.speak(callId, "I'm sorry, I didn't catch that. Could you please repeat?");
        return;
      }

      if (result.text) {
        // Check for transfer signal from the AI (case-insensitive, may appear at start)
        const transferSignal = result.text.toUpperCase().startsWith("[TRANSFER]");
        if (transferSignal) {
          const spokenText = result.text.replace(/\[TRANSFER\]/i, "").trim();
          voiceDebug(`Transfer signal detected, forwarding to ${this.config.fallbackForward?.number}`);
          await this.handleCallForward(callId, call, spokenText);
          return;
        }

        voiceDebug(`Speaking AI response`);
        await this.speakToCall(callId, call.providerCallId ?? callId, result.text);
      } else {
        voiceDebug(`No text returned - speaking fallback`);
        await this.speakToCall(callId, call.providerCallId ?? callId, "I'm sorry, could you say that again?");
      }
    } catch (err) {
      voiceDebug(`CAUGHT ERROR in handleInboundResponse: ${err}`);
      await this.speakToCall(callId, call.providerCallId ?? callId, "I'm sorry, I'm experiencing a technical issue. Would you like me to transfer you to our team?");
    }
  }

  /**
   * Speak text to an active call.
   * When streaming is enabled with a TTS provider (e.g. Cartesia), generates audio
   * externally and sends it through the media stream WebSocket.
   * Otherwise falls back to native provider TTS (e.g. Telnyx speak action).
   */
  private async speakToCall(callId: string, providerCallId: string, text: string): Promise<void> {
    // Telnyx: use Cartesia TTS → playback_start API (media stream is inbound-only, can't inject audio via WebSocket)
    if (this.telephonyTtsProvider && this.provider.name === "telnyx") {
      try {
        const wav = await this.telephonyTtsProvider.synthesizeForPlayback(text);
        voiceDebug(`Playback TTS: ${wav.length} bytes WAV via playbackAudio`);
        await (this.provider as any).playbackAudio({
          providerCallId,
          audio: wav,
          audioType: "wav",
        });
        return;
      } catch (err) {
        voiceDebug(`Playback TTS error: ${err} — falling back to native speak`);
      }
    }

    // Twilio/other: streaming TTS via WebSocket media stream
    if (this.telephonyTtsProvider && this.mediaStreamHandler) {
      const session = this.mediaStreamHandler.getSessionByCallId(providerCallId);
      if (session) {
        try {
          const muLaw = await this.telephonyTtsProvider.synthesizeForTelephony(text);
          voiceDebug(`Streaming TTS: ${muLaw.length} bytes mu-law`);

          const CHUNK_SIZE = 160;
          for (let i = 0; i < muLaw.length; i += CHUNK_SIZE) {
            const chunk = muLaw.subarray(i, Math.min(i + CHUNK_SIZE, muLaw.length));
            this.mediaStreamHandler.sendAudio(session.streamSid, chunk);
          }
          return;
        } catch (err) {
          voiceDebug(`Streaming TTS error: ${err} — falling back to native speak`);
        }
      }
    }

    // Fallback: native provider TTS
    voiceDebug(`Speaking via provider.playTts`);
    const speakResult = await this.manager.speak(callId, text);
    voiceDebug(`speak result: ${JSON.stringify(speakResult)}`);
  }

  /**
   * Forward an active call to the configured fallback number via Twilio <Dial>.
   * Includes loop protection: won't forward if the caller IS the forward number.
   */
  private async handleCallForward(
    callId: string,
    call: { from: string; providerCallId?: string },
    transitionMessage: string,
  ): Promise<void> {
    const fwd = this.config.fallbackForward;
    if (!fwd?.enabled || !fwd?.number) {
      console.warn("[voice-call] Transfer requested but fallbackForward not configured");
      // Speak a fallback message instead
      await this.manager.speak(callId, "I'm sorry, I'm unable to transfer your call right now. Can I take a message instead?");
      return;
    }

    // Loop protection: don't forward if caller is the forward number
    const normalizedFrom = call.from.replace(/\D/g, "");
    const normalizedForward = fwd.number.replace(/\D/g, "");
    if (normalizedFrom === normalizedForward) {
      console.warn(`[voice-call] Loop protection: caller ${call.from} is the forward number`);
      await this.manager.speak(callId, "I'm sorry, I'm unable to transfer this call. How else can I help you?");
      return;
    }

    if (!call.providerCallId) {
      console.warn("[voice-call] Cannot forward: no provider call ID");
      return;
    }

    // Speak the transition message first, then redirect
    const message = transitionMessage || fwd.message || "Connecting you now.";
    console.log(`[voice-call] Forwarding call ${callId} to ${fwd.number}`);

    try {
      // Use provider-native transfer if available (Telnyx)
      if (this.provider.transferCall) {
        // Speak transition message, then transfer
        await this.manager.speak(callId, message);
        // Brief delay to let TTS start playing before transfer takes over
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await this.provider.transferCall({
          callId,
          providerCallId: call.providerCallId,
          to: fwd.number,
          from: this.config.fromNumber,
        });
        console.log(`[voice-call] Call ${callId} transferred to ${fwd.number}`);
        return;
      }

      // Twilio path: update the call with TwiML containing <Dial>
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      if (!accountSid || !authToken) {
        console.error("[voice-call] Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN for forwarding");
        return;
      }

      const callerIdNumber = fwd.callerIdNumber || this.config.fromNumber || "";
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${escapeXmlForTwiml(message)}</Say>
  <Dial callerId="${escapeXmlForTwiml(callerIdNumber)}" timeout="30">
    <Number>${escapeXmlForTwiml(fwd.number)}</Number>
  </Dial>
  <Say voice="Polly.Joanna">We were unable to connect you. Please try again later. Goodbye.</Say>
</Response>`;

      const params = new URLSearchParams({ Twiml: twiml });
      const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${call.providerCallId}.json`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const body = await response.text();
        console.error(`[voice-call] Twilio forward API error: ${response.status} ${body}`);
      } else {
        console.log(`[voice-call] Call ${callId} forwarded to ${fwd.number}`);
      }
    } catch (err) {
      console.error(`[voice-call] Call forward failed:`, err);
    }
  }
}

function escapeXmlForTwiml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
