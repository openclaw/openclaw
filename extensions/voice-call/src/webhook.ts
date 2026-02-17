import http from "node:http";
import { URL } from "node:url";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/voice-call";
import type { VoiceCallConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import type { CallManager } from "./manager.js";
import type { MediaStreamConfig } from "./media-stream.js";
import { MediaStreamHandler } from "./media-stream.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { ElevenLabsScribeSTTProvider } from "./providers/stt-elevenlabs-scribe.js";
import { OpenAIRealtimeSTTProvider } from "./providers/stt-openai-realtime.js";
import type { TwilioProvider } from "./providers/twilio.js";
import { SilenceFiller } from "./silence-filler.js";
import type { NormalizedEvent, WebhookContext } from "./types.js";
import { startStaleCallReaper } from "./webhook/stale-call-reaper.js";

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

type WebhookResponsePayload = {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
};

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

  /** Silence filler — plays ambient SFX while agent is working */
  private silenceFiller: SilenceFiller | null = null;

  /** Maps callSid → streamSid for silence filler routing */
  private callStreamSids = new Map<string, string>();

  constructor(
    config: VoiceCallConfig,
    manager: CallManager,
    provider: VoiceCallProvider,
    coreConfig?: CoreConfig,
  ) {
    this.config = config;
    this.manager = manager;
    this.provider = provider;
    this.coreConfig = coreConfig ?? null;

    // Initialize media stream handler if streaming is enabled
    if (config.streaming?.enabled) {
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
   * Initialize media streaming with configurable STT provider.
   */
  private initializeMediaStreaming(): void {
    const sttProviderType = this.config.streaming?.sttProvider ?? "openai-realtime";

    let sttProvider: OpenAIRealtimeSTTProvider | ElevenLabsScribeSTTProvider;

    if (sttProviderType === "elevenlabs-scribe") {
      const apiKey =
        this.config.streaming?.elevenlabsApiKey ||
        this.config.tts?.elevenlabs?.apiKey ||
        process.env.ELEVENLABS_API_KEY;

      if (!apiKey) {
        console.warn(
          "[voice-call] Streaming enabled but no ElevenLabs API key found for Scribe STT",
        );
        return;
      }

      sttProvider = new ElevenLabsScribeSTTProvider({
        apiKey,
        languageCode: this.config.streaming?.elevenlabsLanguageCode,
        vadSilenceThresholdSecs: this.config.streaming?.silenceDurationMs
          ? this.config.streaming.silenceDurationMs / 1000
          : undefined,
        vadThreshold: this.config.streaming?.vadThreshold,
      });

      console.log("[voice-call] Using ElevenLabs Scribe v2 for STT");
    } else {
      const apiKey = this.config.streaming?.openaiApiKey || process.env.OPENAI_API_KEY;

      if (!apiKey) {
        console.warn("[voice-call] Streaming enabled but no OpenAI API key found");
        return;
      }

      sttProvider = new OpenAIRealtimeSTTProvider({
        apiKey,
        model: this.config.streaming?.sttModel,
        silenceDurationMs: this.config.streaming?.silenceDurationMs,
        vadThreshold: this.config.streaming?.vadThreshold,
      });

      console.log("[voice-call] Using OpenAI Realtime for STT");
    }

    const streamConfig: MediaStreamConfig = {
      sttProvider,
      preStartTimeoutMs: this.config.streaming?.preStartTimeoutMs,
      maxPendingConnections: this.config.streaming?.maxPendingConnections,
      maxPendingConnectionsPerIp: this.config.streaming?.maxPendingConnectionsPerIp,
      maxConnections: this.config.streaming?.maxConnections,
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
        // Only stop silence filler on VAD speech start (not TTS — too noise-sensitive)
        const streamSid = this.callStreamSids.get(providerCallId);
        if (streamSid) {
          this.silenceFiller?.stop(streamSid);
        }
      },
      onPartialTranscript: (callId, partial) => {
        console.log(`[voice-call] Partial for ${callId}: ${partial}`);
        // Barge-in: clear TTS when actual speech is recognized (not just VAD noise)
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).clearTtsQueue(callId);
        }
        const streamSid = this.callStreamSids.get(callId);
        if (streamSid) {
          this.mediaStreamHandler?.clearTtsQueue(streamSid);
        }
      },
      onConnect: (callId, streamSid) => {
        console.log(`[voice-call] Media stream connected: ${callId} -> ${streamSid}`);
        // Register stream with provider for TTS routing
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).registerCallStream(callId, streamSid);
        }
        // Track for silence filler
        this.callStreamSids.set(callId, streamSid);

        // Speak initial message if one was provided when call was initiated
        // Use setTimeout to allow stream setup to complete
        setTimeout(() => {
          this.manager.speakInitialMessage(callId).catch((err) => {
            console.warn(`[voice-call] Failed to speak initial message:`, err);
          });
        }, 100);
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
        // Clean up silence filler
        const streamSid = this.callStreamSids.get(callId);
        if (streamSid) {
          this.silenceFiller?.stop(streamSid);
        }
        this.callStreamSids.delete(callId);
      },
    };

    this.mediaStreamHandler = new MediaStreamHandler(streamConfig);
    this.silenceFiller = new SilenceFiller(this.mediaStreamHandler, {
      thresholdMs: this.config.silenceFiller?.thresholdMs,
      sfxSet: this.config.silenceFiller?.sfxSet,
      enabled: this.config.silenceFiller?.enabled,
    });
    console.log("[voice-call] Media streaming initialized");
  }

  /**
   * Start the webhook server.
   * Idempotent: returns immediately if the server is already listening.
   */
  async start(): Promise<string> {
    const { port, bind, path: webhookPath } = this.config.serve;
    const streamPath = this.config.streaming?.streamPath || "/voice/stream";

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

  private getUpgradePathname(request: http.IncomingMessage): string | null {
    try {
      const host = request.headers.host || "localhost";
      return new URL(request.url || "/", `http://${host}`).pathname;
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
    this.writeWebhookResponse(res, payload);
  }

  private async runWebhookPipeline(
    req: http.IncomingMessage,
    webhookPath: string,
  ): Promise<WebhookResponsePayload> {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

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
      url: `http://${req.headers.host}${req.url}`,
      method: "POST",
      query: Object.fromEntries(url.searchParams),
      remoteAddress: req.socket.remoteAddress ?? undefined,
    };

    const verification = this.provider.verifyWebhook(ctx);
    if (!verification.ok) {
      console.warn(`[voice-call] Webhook verification failed: ${verification.reason}`);
      return { statusCode: 401, body: "Unauthorized" };
    }
    if (!verification.verifiedRequestKey) {
      console.warn("[voice-call] Webhook verification succeeded without request identity key");
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

    return {
      statusCode: parsed.statusCode || 200,
      headers: parsed.providerResponseHeaders,
      body: parsed.providerResponseBody || "OK",
    };
  }

  private processParsedEvents(events: NormalizedEvent[]): void {
    for (const event of events) {
      try {
        this.manager.processEvent(event);
      } catch (err) {
        console.error(`[voice-call] Error processing event ${event.type}:`, err);
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

    if (!this.coreConfig) {
      console.warn("[voice-call] Core config missing; skipping auto-response");
      return;
    }

    // Start silence filler while waiting for the LLM / tool calls
    const streamSid = call.providerCallId
      ? this.callStreamSids.get(call.providerCallId)
      : undefined;
    if (streamSid) {
      this.silenceFiller?.start(streamSid);
    }

    try {
      const { generateVoiceResponse } = await import("./response-generator.js");

      const result = await generateVoiceResponse({
        voiceConfig: this.config,
        coreConfig: this.coreConfig,
        callId,
        from: call.from,
        transcript: call.transcript,
        userMessage,
      });

      // Stop filler before speaking the response
      if (streamSid) {
        this.silenceFiller?.stop(streamSid);
      }

      if (result.error) {
        console.error(`[voice-call] Response generation error: ${result.error}`);
        return;
      }

      if (result.text) {
        console.log(`[voice-call] AI response: "${result.text}"`);
        await this.manager.speak(callId, result.text);

        if (result.endCall) {
          // Agent requested hangup — give TTS a moment to finish, then hang up
          console.log(`[voice-call] Agent requested end_call for ${callId}`);
          setTimeout(() => {
            this.manager.endCall(callId).catch((err: unknown) => {
              console.warn(`[voice-call] Hangup failed:`, err);
            });
          }, 1000);
          return;
        }

        // Restart filler after speaking (in case next turn also needs tools)
        if (streamSid) {
          this.silenceFiller?.start(streamSid);
        }
      }
    } catch (err) {
      // Stop filler on error too
      if (streamSid) {
        this.silenceFiller?.stop(streamSid);
      }
      console.error(`[voice-call] Auto-response error:`, err);
    }
  }
}
