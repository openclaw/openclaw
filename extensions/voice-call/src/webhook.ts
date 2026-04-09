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
import { CALENDAR_TOOLS, executeCalendarTool, prewarmCalendarAuth } from "./calendar-tools.js";
import { edgeTtsFallback } from "./edge-tts-fallback.js";
import { createPostCallSummary } from "./gmail-summary.js";
import { runHealthCheck, startHealthMonitor, stopHealthMonitor, recordSuccessfulCall } from "./health-monitor.js";
import { classifyQueryComplexity } from "./query-classifier.js";
import { streamVoiceResponse } from "./streaming-response.js";
import type { TwilioProvider } from "./providers/twilio.js";
import type { NormalizedEvent, WebhookContext } from "./types.js";
import { startStaleCallReaper } from "./webhook/stale-call-reaper.js";

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/** Keywords that signal the caller wants to book/schedule something. */
const BOOKING_INTENT_PATTERN =
  /\b(schedule|book|appointment|cancel|reschedule|meeting|consultation|slot|available|availability|open.?time|free.?time|come in|set up a time|set up an appointment)\b/i;

/** Patterns that signal the caller wants to be transferred to a human — bypass LLM entirely. */
const TRANSFER_INTENT_PATTERN =
  /\b(talk to a (person|human|real person|representative|agent|someone)|speak to (a |an )?(person|human|someone|representative|agent|manager)|transfer me|connect me|put me through|get me (a |an )?(person|human|someone)|real person|human (please|now)|i('d| would) (like|prefer) (a |to talk to a )(human|person|real person))\b/i;

/** Check if a message or recent transcript contains booking intent. */
function hasBookingIntent(
  currentMessage: string,
  transcript: Array<{ speaker: string; text: string }>,
): boolean {
  if (BOOKING_INTENT_PATTERN.test(currentMessage)) return true;
  // Check last 4 transcript entries (recent context)
  const recent = transcript.slice(-4);
  for (const entry of recent) {
    if (BOOKING_INTENT_PATTERN.test(entry.text)) return true;
  }
  return false;
}

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
  /** Track which calls are currently speaking (turn management — suppress STT during TTS) */
  private speakingCalls = new Set<string>();
  /** Prevent duplicate transfer attempts per call */
  private transferringCalls = new Set<string>();
  /** Calls that have been transferred to a human — AI should ignore all further events */
  private transferredCalls = new Set<string>();
  /** Queued user utterances received while bot was speaking — process after playback ends */
  private pendingUtterances = new Map<string, string>();
  /** Abort controllers for active streaming responses — keyed by callId for barge-in cancellation */
  private activeResponseControllers = new Map<string, AbortController>();
  /** Track which calls have already booked a calendar appointment (prevent duplicates) */
  private bookedCalls = new Set<string>();
  /** Track calls where booking/scheduling intent was detected — sticky once set */
  private bookingIntentCalls = new Set<string>();
  /** Accumulation buffer for short transcripts — prevents cutting off names mid-utterance */
  private transcriptAccum = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();
  /** Track which calls have active Deepgram streaming (suppress native transcription handler) */
  private streamingActiveCalls = new Set<string>();
  /** Track which calls are using native transcription fallback (for transcription restart) */
  private nativeTranscriptionCalls = new Set<string>();
  /** Track last webhook timestamp per call for watchdog */
  private lastWebhookTime = new Map<string, number>();

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

    // Pre-warm Google Calendar OAuth token so first tool call is fast
    if (this.config.calendarEnabled && this.config.calendarId) {
      prewarmCalendarAuth(this.config.calendarId);
    }

    // Start periodic health monitoring with ntfy alerts
    if (this.config.healthCheckEnabled) {
      startHealthMonitor(this.buildHealthConfig());
    }
  }

  /** Build health monitor config from voice config + env. */
  private buildHealthConfig() {
    const ttsConfig = (this.config as any).tts;
    return {
      telnyxApiKey: this.config.telnyx?.apiKey || process.env.TELNYX_API_KEY || "",
      cartesiaApiKey: ttsConfig?.cartesia?.apiKey || process.env.CARTESIA_API_KEY,
      cartesiaVoiceId: ttsConfig?.cartesia?.voiceId,
      cartesiaModelId: ttsConfig?.cartesia?.modelId,
      deepgramApiKey: this.config.streaming.deepgramApiKey || process.env.DEEPGRAM_API_KEY,
      anthropicApiKey: process.env.OPENCLAW_LIVE_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY,
      anthropicBaseUrl: (this.coreConfig as any)?.providers?.anthropic?.baseUrl,
      ntfyTopic: this.config.healthCheckNtfyTopic || undefined,
      intervalMs: (this.config.healthCheckIntervalMin || 30) * 60 * 1000,
    };
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
      // Telnyx media fork sends G722 audio — our G722 decoder transcodes to linear16 @ 16kHz
      const isTelnyx = this.provider.name === "telnyx";
      sttProvider = new DeepgramSTTProvider({
        apiKey,
        model: streaming.deepgramModel,
        endpointingMs: streaming.silenceDurationMs,
        language: "en",
        encoding: isTelnyx ? "linear16" : "mulaw",
        sampleRate: isTelnyx ? 16000 : 8000,
      });
      console.log(`[voice-call] STT provider: deepgram (model: ${streaming.deepgramModel}, encoding: ${isTelnyx ? "linear16" : "mulaw"}, rate: ${isTelnyx ? 16000 : 8000})`);
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

        // Telnyx barge-in on transcript: if we're still speaking when a full transcript
        // arrives, force-stop playback and cancel the AI response (backup for onSpeechStart)
        if (this.provider.name === "telnyx" && this.speakingCalls.has(call.callId)) {
          voiceDebug(`BARGE-IN (transcript): interrupting playback for ${call.callId}`);
          if (call.providerCallId) {
            void (this.provider as import("./providers/telnyx.js").TelnyxProvider)
              .playbackStop({ providerCallId: call.providerCallId })
              .catch((err) => voiceDebug(`BARGE-IN: playback_stop error: ${err}`));
          }
          const controller = this.activeResponseControllers.get(call.callId);
          if (controller) {
            controller.abort();
            this.activeResponseControllers.delete(call.callId);
          }
          this.speakingCalls.delete(call.callId);
          this.pendingUtterances.delete(call.callId);
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
          const wordCount = transcript.trim().split(/\s+/).length;
          // Short transcripts (≤3 words) get a 600ms accumulation window to catch
          // multi-part names like "John... Smith" that Deepgram splits across utterances
          if (wordCount <= 3) {
            const existing = this.transcriptAccum.get(call.callId);
            if (existing) {
              clearTimeout(existing.timer);
              existing.text += " " + transcript;
              voiceDebug(`Accumulating short transcript: "${existing.text}"`);
              existing.timer = setTimeout(() => {
                this.transcriptAccum.delete(call.callId);
                voiceDebug(`Accumulation timer fired: "${existing.text}"`);
                this.handleInboundResponse(call.callId, existing.text).catch((err) => {
                  console.warn(`[voice-call] Failed to auto-respond:`, err);
                });
              }, 600);
            } else {
              const accum = {
                text: transcript,
                timer: setTimeout(() => {
                  this.transcriptAccum.delete(call.callId);
                  voiceDebug(`Accumulation timer fired: "${accum.text}"`);
                  this.handleInboundResponse(call.callId, accum.text).catch((err) => {
                    console.warn(`[voice-call] Failed to auto-respond:`, err);
                  });
                }, 600),
              };
              this.transcriptAccum.set(call.callId, accum);
              voiceDebug(`Short transcript queued for accumulation: "${transcript}"`);
            }
          } else {
            // Longer utterances — process immediately, flush any pending accumulation
            let finalTranscript = transcript;
            const existing = this.transcriptAccum.get(call.callId);
            if (existing) {
              clearTimeout(existing.timer);
              this.transcriptAccum.delete(call.callId);
              finalTranscript = existing.text + " " + transcript;
              voiceDebug(`Flushed accumulation + new transcript: "${finalTranscript}"`);
            }
            this.handleInboundResponse(call.callId, finalTranscript).catch((err) => {
              console.warn(`[voice-call] Failed to auto-respond:`, err);
            });
          }
        }
      },
      onSpeechStart: (providerCallId) => {
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).clearTtsQueue(providerCallId);
        }

        // Telnyx barge-in: stop playback and cancel AI response when caller interrupts
        if (this.provider.name === "telnyx") {
          const call = this.manager.getCallByProviderCallId(providerCallId);
          if (!call) return;

          if (this.speakingCalls.has(call.callId)) {
            voiceDebug(`BARGE-IN: speech detected during playback for ${call.callId}`);

            // 1. Stop Telnyx audio playback
            if (call.providerCallId) {
              void (this.provider as import("./providers/telnyx.js").TelnyxProvider)
                .playbackStop({ providerCallId: call.providerCallId })
                .then(() => voiceDebug(`BARGE-IN: playback stopped for ${call.callId}`))
                .catch((err) => voiceDebug(`BARGE-IN: playback_stop error: ${err}`));
            }

            // 2. Abort in-flight Haiku streaming response
            const controller = this.activeResponseControllers.get(call.callId);
            if (controller) {
              controller.abort();
              this.activeResponseControllers.delete(call.callId);
              voiceDebug(`BARGE-IN: streaming response aborted for ${call.callId}`);
            }

            // 3. Clear speaking state so next transcript processes immediately
            this.speakingCalls.delete(call.callId);
            this.pendingUtterances.delete(call.callId);
          }
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

    // Health check endpoint — returns component status as JSON
    if (url.pathname === "/voice/health") {
      const snapshot = await runHealthCheck(this.buildHealthConfig());
      return {
        statusCode: snapshot.ok ? 200 : 503,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot, null, 2),
      };
    }

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
      // Update watchdog timestamp for this call
      if (event.callId) {
        const call = this.manager.getCall(event.callId) ??
          this.manager.getCallByProviderCallId(event.callId);
        if (call) this.lastWebhookTime.set(call.callId, Date.now());
      }

      // Capture call record BEFORE processEvent deletes it (call.ended removes from activeCalls)
      let endedCallSnapshot: { callId: string; from: string; startedAt: number; endedAt?: number; transcript: any[]; } | null = null;
      if (event.type === "call.ended" && event.callId) {
        const endingCall = this.manager.getCall(event.callId) ??
          this.manager.getCallByProviderCallId(event.callId);
        if (endingCall) {
          endedCallSnapshot = {
            callId: endingCall.callId,
            from: endingCall.from,
            startedAt: endingCall.startedAt,
            endedAt: Date.now(),
            transcript: [...endingCall.transcript],
          };
        }
      }

      try {
        this.manager.processEvent(event);
      } catch (err) {
        console.error(`[voice-call] Error processing event ${event.type}:`, err);
      }
      // Clean up tracking sets when a call ends
      if (event.type === "call.ended" && event.callId) {
        const cid = event.callId;

        // Fire post-call Gmail summary (async, non-blocking)
        if (this.config.gmailSummaryEnabled && this.config.gmailSummaryRecipient && endedCallSnapshot) {
          const apiKey = process.env.OPENCLAW_LIVE_ANTHROPIC_KEY
            || process.env.ANTHROPIC_API_KEY
            || "";
          if (apiKey) {
            const baseUrl = (this.coreConfig as any)?.providers?.anthropic?.baseUrl
              || "https://api.anthropic.com";
            void createPostCallSummary({
              callId: endedCallSnapshot.callId,
              from: endedCallSnapshot.from,
              startedAt: endedCallSnapshot.startedAt,
              endedAt: endedCallSnapshot.endedAt,
              transcript: endedCallSnapshot.transcript,
              wasTransferred: this.transferredCalls.has(cid),
              wasBooked: this.bookedCalls.has(cid),
              summaryRecipient: this.config.gmailSummaryRecipient,
              apiKey,
              baseUrl,
            });
          }
        }

        this.streamingActiveCalls.delete(cid);
        this.nativeTranscriptionCalls.delete(cid);
        this.lastWebhookTime.delete(cid);
        this.speakingCalls.delete(cid);
        this.pendingUtterances.delete(cid);
        this.answeredCalls.delete(cid);
        this.pendingGreetings.delete(cid);
        this.transferringCalls.delete(cid);
        this.transferredCalls.delete(cid);
        this.bookedCalls.delete(cid);
        this.bookingIntentCalls.delete(cid);
        // Cancel any pending accumulation timer
        const accum = this.transcriptAccum.get(cid);
        if (accum) { clearTimeout(accum.timer); this.transcriptAccum.delete(cid); }
        // Abort any in-flight response and clean up
        this.activeResponseControllers.get(cid)?.abort();
        this.activeResponseControllers.delete(cid);
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

        if (this.config.streaming.enabled && this.provider.startStreaming) {
          // Try streaming mode with retries — Telnyx 90046 is intermittent
          const MAX_STREAM_RETRIES = 3;
          const STREAM_RETRY_DELAY_MS = 2000;
          setTimeout(async () => {
            const streamUrl = this.getStreamWebSocketUrl();
            if (!streamUrl) {
              voiceDebug(`Cannot start streaming: no public WebSocket URL available`);
              this.startNativeTranscription(cid, pcid);
              return;
            }
            for (let attempt = 1; attempt <= MAX_STREAM_RETRIES; attempt++) {
              try {
                voiceDebug(`Starting audio stream for ${cid} → ${streamUrl} (attempt ${attempt}/${MAX_STREAM_RETRIES})`);
                await this.provider.startStreaming!({ providerCallId: pcid, streamUrl });
                voiceDebug(`Audio streaming started for ${cid}`);
                this.streamingActiveCalls.add(cid);
                return; // Success — exit retry loop
              } catch (err) {
                voiceDebug(`Failed to start audio streaming (attempt ${attempt}): ${err}`);
                if (this.provider.stopStreaming) {
                  voiceDebug(`Cleaning up streaming state for ${cid}`);
                  await this.provider.stopStreaming({ providerCallId: pcid }).catch(() => {});
                }
                if (attempt < MAX_STREAM_RETRIES) {
                  voiceDebug(`Retrying streaming in ${STREAM_RETRY_DELAY_MS}ms...`);
                  await new Promise((r) => setTimeout(r, STREAM_RETRY_DELAY_MS));
                }
              }
            }
            // All retries exhausted — fall back to native transcription
            voiceDebug(`All ${MAX_STREAM_RETRIES} streaming attempts failed for ${cid} — falling back to native transcription`);
            this.startNativeTranscription(cid, pcid);
          }, 2000);
        } else {
          // Native transcription mode
          setTimeout(() => {
            this.startNativeTranscription(cid, pcid);
          }, 2000);
        }
      }
      return;
    }

    // Restart transcription after TTS finishes (Telnyx stops listening during speak).
    // Only needed for native transcription — streaming mode keeps audio fork active during speak.
    // Suppress Telnyx error 90054 ("transcription already in progress") — harmless race.
    if (event.type === "call.active") {
      // Clear speaking flag — playback finished, ready for next turn
      const activeCall =
        this.manager.getCall(event.callId) ??
        this.manager.getCallByProviderCallId(event.providerCallId || event.callId);
      if (activeCall) {
        // Skip ALL processing if this call has been transferred to a human
        if (this.transferredCalls.has(activeCall.callId)) {
          voiceDebug(`call.active SKIPPED for ${activeCall.callId} — call transferred to human`);
          return;
        }
        this.speakingCalls.delete(activeCall.callId);
        voiceDebug(`Playback ended for ${activeCall.callId} — ready for next turn`);

        // Process any queued utterance that came in while we were speaking
        const queued = this.pendingUtterances.get(activeCall.callId);
        if (queued) {
          this.pendingUtterances.delete(activeCall.callId);
          voiceDebug(`Processing queued utterance for ${activeCall.callId}: "${queued}"`);
          void this.handleInboundResponse(activeCall.callId, queued).catch((err) => {
            voiceDebug(`Queued response error: ${err}`);
          });
        }
      }

      // If Deepgram streaming is active for this call, audio fork stays active — no restart needed.
      // But if the call fell back to native transcription, we MUST restart it after speak ends.
      const call =
        this.manager.getCall(event.callId) ??
        this.manager.getCallByProviderCallId(event.providerCallId || event.callId);
      if (call && this.streamingActiveCalls.has(call.callId)) {
        return; // Deepgram streaming handles this call — no transcription restart needed
      }
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

    // Auto-respond to final speech transcripts from native provider transcription.
    // Skip if Deepgram streaming is active for this call (it handles transcripts separately).
    if (
      event.type === "call.speech" &&
      "isFinal" in event &&
      event.isFinal &&
      "transcript" in event
    ) {
      // Check if streaming is handling this call's transcripts
      const speechCall = this.manager.getCall(event.callId) ??
        this.manager.getCallByProviderCallId(event.callId);
      if (speechCall && this.streamingActiveCalls.has(speechCall.callId)) {
        voiceDebug(`Ignoring native transcript — Deepgram streaming active for ${speechCall.callId}`);
        return;
      }
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

  /**
   * Start native Telnyx transcription with a watchdog timer.
   * If no webhooks arrive within 10 seconds, retries once.
   */
  private startNativeTranscription(callId: string, providerCallId: string): void {
    this.nativeTranscriptionCalls.add(callId);
    this.lastWebhookTime.set(callId, Date.now());
    voiceDebug(`Starting native transcription for ${callId} (provider: ${providerCallId})`);
    void this.provider
      .startListening({ callId, providerCallId })
      .then(() => {
        voiceDebug(`Native transcription started for ${callId}`);
      })
      .catch((err) => {
        voiceDebug(`Failed to start native transcription: ${err}`);
      });

    // Watchdog: if no webhook arrives within 10s, retry transcription_start
    setTimeout(() => {
      const lastTime = this.lastWebhookTime.get(callId);
      if (!lastTime || Date.now() - lastTime > 9000) {
        const call = this.manager.getCall(callId);
        if (call) {
          voiceDebug(`Watchdog: no webhooks for ${callId} in 10s — retrying transcription_start`);
          void this.provider
            .startListening({ callId, providerCallId })
            .catch((err) => {
              voiceDebug(`Watchdog retry failed: ${err}`);
            });
        }
      }
    }, 10000);
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
    // Bail out if call has been transferred to a human
    if (this.transferredCalls.has(callId)) {
      voiceDebug(`handleInboundResponse SKIPPED: call ${callId} already transferred to human`);
      return;
    }

    console.log(`[voice-call] Auto-responding to inbound call ${callId}: "${userMessage}"`);

    const call = this.manager.getCall(callId);
    if (!call) {
      console.warn(`[voice-call] Call ${callId} not found for auto-response`);
      return;
    }

    voiceDebug(`handleInboundResponse START callId=${callId} msg="${userMessage}"`);

    const providerCallId = call.providerCallId ?? callId;

    // Turn management: queue utterance if we're currently speaking (prevents overlapping responses)
    if (this.speakingCalls.has(callId)) {
      voiceDebug(`Queuing utterance — call ${callId} is still speaking: "${userMessage}"`);
      this.pendingUtterances.set(callId, userMessage);
      return;
    }

    // Fast-path transfer: if caller explicitly asks for a human, skip the LLM entirely
    if (this.config.fallbackForward?.enabled && TRANSFER_INTENT_PATTERN.test(userMessage)) {
      voiceDebug(`FAST TRANSFER: detected transfer intent in "${userMessage}" — skipping LLM`);
      call.transcript.push({ timestamp: Date.now(), speaker: "user", text: userMessage, isFinal: true });
      const transitionMsg = this.config.fallbackForward.message || "Sure, let me connect you with someone right away.";
      await this.speakToCall(callId, providerCallId, transitionMsg);
      await this.handleCallForward(callId, call, "");
      return;
    }

    // Resolve Anthropic API key
    const apiKey = process.env.OPENCLAW_LIVE_ANTHROPIC_KEY
      || process.env.ANTHROPIC_API_KEY
      || "";

    // Use streaming pipeline when we have an API key and Cartesia TTS
    if (apiKey && this.telephonyTtsProvider && this.provider.name === "telnyx") {
      const baseUrl = (this.coreConfig as any)?.providers?.anthropic?.baseUrl
        || "https://api.anthropic.com";
      const startTime = Date.now();
      let sentenceCount = 0;
      let firstSentenceTime = 0;

      // Escalation routing: classify query and select model
      let selectedModel: string | undefined;
      if (this.config.escalationEnabled && this.config.escalationModel) {
        const classification = classifyQueryComplexity(userMessage, call.transcript.length);
        if (classification.level === "complex") {
          selectedModel = this.config.escalationModel;
          voiceDebug(`ESCALATION: routing to ${selectedModel} (score=${classification.score}, signals=[${classification.signals.join(",")}])`);
        } else {
          voiceDebug(`Escalation check: simple (score=${classification.score})`);
        }
      }

      const effectiveModel = selectedModel || this.config.responseModel;
      voiceDebug(`Streaming response with model=${effectiveModel}...`);

      // Barge-in: create AbortController so onSpeechStart can cancel this response
      const responseController = new AbortController();
      this.activeResponseControllers.set(callId, responseController);

      // Queue of TTS promises to await in order (Telnyx queues playback automatically)
      const ttsQueue: Promise<void>[] = [];

      // Calendar tools: only include when booking intent is detected (avoids 5-8s tool definition latency on every turn)
      const calendarEnabled = this.config.calendarEnabled && this.config.calendarId;
      const calendarId = this.config.calendarId || "primary";

      // Detect booking intent — once detected, stays sticky for the rest of the call
      let includeTools = false;
      if (calendarEnabled) {
        if (this.bookingIntentCalls.has(callId)) {
          includeTools = true;
        } else if (hasBookingIntent(userMessage, call.transcript)) {
          this.bookingIntentCalls.add(callId);
          includeTools = true;
          voiceDebug(`Booking intent detected for call ${callId} — enabling calendar tools`);
        }
      }

      await streamVoiceResponse({
        voiceConfig: this.config,
        apiKey,
        baseUrl,
        from: call.from,
        transcript: call.transcript,
        userMessage,
        timeoutMs: this.config.responseTimeoutMs ?? 15000,
        signal: responseController.signal,
        modelOverride: selectedModel,
        tools: includeTools ? [...CALENDAR_TOOLS] : undefined,
        toolExecutor: includeTools
          ? async (toolName, input) => {
              voiceDebug(`TOOL CALL: ${toolName}(${JSON.stringify(input)})`);
              // Prevent duplicate bookings per call
              if (toolName === "book_appointment" && this.bookedCalls.has(callId)) {
                voiceDebug(`TOOL BLOCKED: duplicate book_appointment for call ${callId}`);
                return JSON.stringify({ success: true, message: "Appointment was already booked for this caller." });
              }
              const result = await executeCalendarTool(toolName, input as Record<string, string>, calendarId);
              // Track successful bookings
              if (toolName === "book_appointment" && !result.includes('"error"')) {
                this.bookedCalls.add(callId);
                voiceDebug(`Booking tracked for call ${callId}`);
              }
              return result;
            }
          : undefined,

        onSentence: (sentence) => {
          sentenceCount++;
          if (sentenceCount === 1) {
            firstSentenceTime = Date.now() - startTime;
            voiceDebug(`First sentence in ${firstSentenceTime}ms: "${sentence}"`);
          } else {
            voiceDebug(`Sentence #${sentenceCount}: "${sentence}"`);
          }

          // Check for transfer signal
          if (sentence.toUpperCase().startsWith("[TRANSFER]")) {
            const spokenText = sentence.replace(/\[TRANSFER\]/i, "").trim();
            voiceDebug(`Transfer signal in stream`);
            ttsQueue.push(
              this.speakToCall(callId, providerCallId, spokenText).then(() =>
                this.handleCallForward(callId, call, "")
              )
            );
            return;
          }

          // Fire-and-forget TTS for this sentence (Telnyx queues playbacks)
          const ttsPromise = this.speakToCall(callId, providerCallId, sentence).catch((err) => {
            voiceDebug(`Streaming TTS error for sentence: ${err}`);
          });
          ttsQueue.push(ttsPromise);
        },

        onDone: (fullText) => {
          const totalTime = Date.now() - startTime;
          voiceDebug(`Stream complete: ${sentenceCount} sentences, ${totalTime}ms total, first sentence at ${firstSentenceTime}ms`);
          // Record successful call for health monitoring
          if (sentenceCount > 0) recordSuccessfulCall();
          // Add full response to transcript
          if (fullText) {
            call.transcript.push({ timestamp: Date.now(), speaker: "bot", text: fullText, isFinal: true });
          }
        },

        onError: (error) => {
          voiceDebug(`Stream error: ${error.message}`);
        },
      });

      // Clean up barge-in controller
      this.activeResponseControllers.delete(callId);

      // If barge-in aborted and no tools were active, skip remaining TTS
      // (When tools are active, streamVoiceResponse handles barge-in internally
      // and still completes tool execution + follow-up response)
      if (responseController.signal.aborted && !includeTools) {
        voiceDebug(`Streaming response was barge-in aborted — skipping remaining TTS`);
        return;
      }

      // Wait for all queued TTS to finish sending to Telnyx
      await Promise.all(ttsQueue);

      // If no sentences were produced, speak a fallback
      if (sentenceCount === 0) {
        voiceDebug(`No sentences from stream - speaking fallback`);
        await this.speakToCall(callId, providerCallId, "I'm sorry, could you say that again?");
      }
      return;
    }

    // Fallback: non-streaming path (no API key or non-Telnyx provider)
    if (!this.coreConfig) {
      voiceDebug(`coreConfig is NULL - speaking fallback`);
      await this.manager.speak(callId, "I'm sorry, I'm having a technical issue.");
      return;
    }

    try {
      const { generateVoiceResponse } = await import("./response-generator.js");
      voiceDebug(`Calling generateVoiceResponse (non-streaming) with model=${this.config.responseModel}...`);
      const result = await generateVoiceResponse({
        voiceConfig: this.config,
        coreConfig: this.coreConfig,
        callId,
        from: call.from,
        transcript: call.transcript,
        userMessage,
      });

      voiceDebug(`generateVoiceResponse returned: text=${result.text ? `"${result.text.slice(0,80)}"` : "null"} error=${result.error || "none"}`);

      if (result.text) {
        const transferSignal = result.text.toUpperCase().startsWith("[TRANSFER]");
        if (transferSignal) {
          const spokenText = result.text.replace(/\[TRANSFER\]/i, "").trim();
          await this.handleCallForward(callId, call, spokenText);
          return;
        }
        await this.speakToCall(callId, providerCallId, result.text);
      } else {
        await this.speakToCall(callId, providerCallId, "I'm sorry, could you say that again?");
      }
    } catch (err) {
      voiceDebug(`CAUGHT ERROR in handleInboundResponse: ${err}`);
      await this.speakToCall(callId, providerCallId, "I'm sorry, I'm experiencing a technical issue. Would you like me to transfer you to our team?");
    }
  }

  /**
   * Speak text to an active call.
   * When streaming is enabled with a TTS provider (e.g. Cartesia), generates audio
   * externally and sends it through the media stream WebSocket.
   * Otherwise falls back to native provider TTS (e.g. Telnyx speak action).
   */
  private async speakToCall(callId: string, providerCallId: string, text: string): Promise<void> {
    this.speakingCalls.add(callId);
    // Safety valve: auto-clear speaking flag if playback.ended webhook doesn't arrive.
    // Estimate audio duration from text length (~150ms per word) + 3s buffer for TTS generation.
    const wordCount = text.split(/\s+/).length;
    const estimatedMs = Math.max(5000, wordCount * 150 + 3000);
    setTimeout(() => {
      if (this.speakingCalls.has(callId)) {
        voiceDebug(`Speaking timeout for ${callId} after ${estimatedMs}ms — forcing turn open`);
        this.speakingCalls.delete(callId);
        // Process any queued utterance
        const queued = this.pendingUtterances.get(callId);
        if (queued) {
          this.pendingUtterances.delete(callId);
          voiceDebug(`Processing queued utterance after timeout: "${queued}"`);
          void this.handleInboundResponse(callId, queued).catch(() => {});
        }
      }
    }, estimatedMs);

    // Telnyx: use Cartesia TTS → playback_start API (media stream is inbound-only, can't inject audio via WebSocket)
    // Falls back to Edge TTS (free, no API key) if Cartesia fails/times out.
    if (this.telephonyTtsProvider && this.provider.name === "telnyx") {
      // Try Cartesia first (8s timeout — fail fast so Edge fallback stays responsive)
      let audioBuffer: Buffer | null = null;
      let audioType: "mp3" | "wav" = "wav";

      try {
        const cartesiaTimeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Cartesia timeout (8s)")), 8000)
        );
        audioBuffer = await Promise.race([
          this.telephonyTtsProvider.synthesizeForPlayback(text),
          cartesiaTimeout,
        ]);
        audioType = "wav";
        voiceDebug(`Playback TTS (Cartesia): ${audioBuffer.length} bytes WAV`);
      } catch (err) {
        voiceDebug(`Cartesia TTS failed: ${err} — trying Edge TTS fallback`);
        try {
          const edge = await edgeTtsFallback(text);
          audioBuffer = edge.audio;
          audioType = edge.format;
          voiceDebug(`Playback TTS (Edge fallback): ${audioBuffer.length} bytes MP3`);
        } catch (edgeErr) {
          voiceDebug(`Edge TTS fallback also failed: ${edgeErr}`);
        }
      }

      if (audioBuffer) {
        try {
          await (this.provider as any).playbackAudio({
            providerCallId,
            audio: audioBuffer,
            audioType,
          });
          return;
        } catch (playErr) {
          voiceDebug(`Telnyx playback error: ${playErr}`);
        }
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
    // Prevent duplicate transfer attempts
    if (this.transferringCalls.has(callId)) {
      voiceDebug(`Transfer SKIPPED: already transferring ${callId}`);
      return;
    }
    this.transferringCalls.add(callId);

    const fwd = this.config.fallbackForward;
    voiceDebug(`handleCallForward: fwd=${JSON.stringify(fwd)} call.from=${call.from} providerCallId=${call.providerCallId}`);
    if (!fwd?.enabled || !fwd?.number) {
      console.warn("[voice-call] Transfer requested but fallbackForward not configured");
      voiceDebug(`Transfer BLOCKED: fallbackForward not configured (enabled=${fwd?.enabled} number=${fwd?.number})`);
      // Speak a fallback message instead
      await this.manager.speak(callId, "I'm sorry, I'm unable to transfer your call right now. Can I take a message instead?");
      return;
    }

    // Loop protection: don't forward if caller is the forward number
    const normalizedFrom = call.from.replace(/\D/g, "");
    const normalizedForward = fwd.number.replace(/\D/g, "");
    if (normalizedFrom === normalizedForward) {
      console.warn(`[voice-call] Loop protection: caller ${call.from} is the forward number`);
      voiceDebug(`Transfer BLOCKED: loop protection (from=${normalizedFrom} === forward=${normalizedForward})`);
      await this.manager.speak(callId, "I'm sorry, I'm unable to transfer this call. How else can I help you?");
      return;
    }

    if (!call.providerCallId) {
      console.warn("[voice-call] Cannot forward: no provider call ID");
      voiceDebug(`Transfer BLOCKED: no providerCallId`);
      return;
    }

    // Speak the transition message first, then redirect
    const message = transitionMessage || fwd.message || "Connecting you now.";
    console.log(`[voice-call] Forwarding call ${callId} to ${fwd.number}`);
    voiceDebug(`Transfer EXECUTING: to=${fwd.number} from=${this.config.fromNumber} msg="${message}"`);

    try {
      // Use provider-native transfer if available (Telnyx)
      if (this.provider.transferCall) {
        // CRITICAL: Mark call as transferred FIRST — before speaking or any other action.
        // This prevents the call.active handler from restarting transcription or
        // processing queued utterances during the transfer flow.
        this.transferredCalls.add(callId);
        this.streamingActiveCalls.delete(callId);
        this.nativeTranscriptionCalls.delete(callId);
        this.speakingCalls.delete(callId);
        voiceDebug(`Transfer: AI disengaged from ${callId}`);

        // Speak transition message via TTS (Cartesia)
        await this.manager.speak(callId, message);
        voiceDebug(`Transfer: transition TTS queued, waiting 4s for playback...`);

        // Wait for TTS to finish playing
        await new Promise((resolve) => setTimeout(resolve, 4000));

        // DO NOT send stopStreaming or transcription_start — any command to the call
        // during transfer can cause Telnyx to disconnect the caller.
        // Telnyx will clean up the media stream automatically when transfer completes.

        voiceDebug(`Transfer: calling provider.transferCall now`);
        await this.provider.transferCall({
          callId,
          providerCallId: call.providerCallId,
          to: fwd.number,
          from: this.config.fromNumber,
        });
        console.log(`[voice-call] Call ${callId} transferred to ${fwd.number}`);
        voiceDebug(`Transfer SUCCESS: call transferred to ${fwd.number}`);
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
    } catch (err: any) {
      console.error(`[voice-call] Call forward failed:`, err);
      voiceDebug(`Transfer FAILED: ${err?.message || err}`);
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
