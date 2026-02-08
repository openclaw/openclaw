import { spawn } from "node:child_process";
import http from "node:http";
import { URL } from "node:url";
import type { VoiceCallConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import type { CallManager } from "./manager.js";
import type { MediaStreamConfig } from "./media-stream.js";
import type { VoiceCallProvider } from "./providers/base.js";
import type { TwilioProvider } from "./providers/twilio.js";
import type { NormalizedEvent, WebhookContext } from "./types.js";
import { MediaStreamHandler } from "./media-stream.js";
import { OpenAIRealtimeSTTProvider } from "./providers/stt-openai-realtime.js";

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/**
 * HTTP server for receiving voice call webhooks from providers.
 * Supports WebSocket upgrades for media streams when streaming is enabled.
 */
export class VoiceCallWebhookServer {
  private server: http.Server | null = null;
  private config: VoiceCallConfig;
  private manager: CallManager;
  private provider: VoiceCallProvider;
  private coreConfig: CoreConfig | null;

  /** Media stream handler for bidirectional audio (when streaming enabled) */
  private mediaStreamHandler: MediaStreamHandler | null = null;

  // Debounced auto-response state for provider webhook transcripts (e.g. Telnyx call.transcription)
  private pendingResponseTimers = new Map<string, NodeJS.Timeout>();
  private pendingResponseText = new Map<string, string>();
  private pendingResponseIsFinal = new Map<string, boolean>();
  private pendingResponseNormalized = new Map<string, string>();
  private pendingResponseScore = new Map<string, number>();
  private pendingResponseGeneration = new Map<string, number>();
  private inFlightResponseGeneration = new Map<string, number>();
  private lastRespondedText = new Map<string, string>();
  private lastRespondedAt = new Map<string, number>();
  private responseGeneration = new Map<string, number>();
  private readonly responseDebounceMsFinal = 300;
  private readonly responseDebounceMsNonFinal = 800;
  private readonly responseCooldownMs = 1800;
  private readonly inFlightRetryMs = 250;
  private readonly duplicateResponseWindowMs = 4000;
  private readonly tinyWords = new Set(["a", "an", "the", "uh", "um", "hmm", "mm", "hm", "er", "ah", "i"]);
  private readonly commonVerbs = new Set([
    "am",
    "are",
    "is",
    "was",
    "were",
    "be",
    "been",
    "being",
    "do",
    "does",
    "did",
    "can",
    "could",
    "will",
    "would",
    "should",
    "shall",
    "have",
    "has",
    "had",
    "need",
    "know",
    "tell",
    "show",
    "give",
    "get",
    "find",
    "check",
    "want",
    "help",
    "make",
    "go",
    "come",
    "say",
    "think",
  ]);
  private readonly questionStarters = new Set(["who", "what", "when", "where", "why", "how", "which"]);

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
   * Initialize media streaming with OpenAI Realtime STT.
   */
  private initializeMediaStreaming(): void {
    const apiKey = this.config.streaming?.openaiApiKey || process.env.OPENAI_API_KEY;

    if (!apiKey) {
      console.warn("[voice-call] Streaming enabled but no OpenAI API key found");
      return;
    }

    const sttProvider = new OpenAIRealtimeSTTProvider({
      apiKey,
      model: this.config.streaming?.sttModel,
      silenceDurationMs: this.config.streaming?.silenceDurationMs,
      vadThreshold: this.config.streaming?.vadThreshold,
    });

    const streamConfig: MediaStreamConfig = {
      sttProvider,
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

        // If caller interrupted while bot was speaking, cancel pending responses.
        if (call.state === "speaking") {
          this.handleBargeIn(call.callId, providerCallId);
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
          this.queueAutoResponse(call.callId, transcript, { isFinal: true });
        }
      },
      onSpeechStart: (providerCallId) => {
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).clearTtsQueue(providerCallId);
        }
        const call = this.manager.getCallByProviderCallId(providerCallId);
        if (call) {
          this.handleBargeIn(call.callId, providerCallId);
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
   */
  async start(): Promise<string> {
    const { port, bind, path: webhookPath } = this.config.serve;
    const streamPath = this.config.streaming?.streamPath || "/voice/stream";

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
          const url = new URL(request.url || "/", `http://${request.headers.host}`);

          if (url.pathname === streamPath) {
            console.log("[voice-call] WebSocket upgrade for media stream");
            this.mediaStreamHandler?.handleUpgrade(request, socket, head);
          } else {
            socket.destroy();
          }
        });
      }

      this.server.on("error", reject);

      this.server.listen(port, bind, () => {
        const url = `http://${bind}:${port}${webhookPath}`;
        console.log(`[voice-call] Webhook server listening on ${url}`);
        if (this.mediaStreamHandler) {
          console.log(`[voice-call] Media stream WebSocket on ws://${bind}:${port}${streamPath}`);
        }
        resolve(url);
      });
    });
  }

  /**
   * Stop the webhook server.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle incoming HTTP request.
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    webhookPath: string,
  ): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    // Check path
    if (!url.pathname.startsWith(webhookPath)) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    // Only accept POST
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return;
    }

    // Read body
    let body = "";
    try {
      body = await this.readBody(req, MAX_WEBHOOK_BODY_BYTES);
    } catch (err) {
      if (err instanceof Error && err.message === "PayloadTooLarge") {
        res.statusCode = 413;
        res.end("Payload Too Large");
        return;
      }
      throw err;
    }

    // Build webhook context
    const ctx: WebhookContext = {
      headers: req.headers as Record<string, string | string[] | undefined>,
      rawBody: body,
      url: `http://${req.headers.host}${req.url}`,
      method: "POST",
      query: Object.fromEntries(url.searchParams),
      remoteAddress: req.socket.remoteAddress ?? undefined,
    };

    // Verify signature
    const verification = this.provider.verifyWebhook(ctx);
    if (!verification.ok) {
      console.warn(`[voice-call] Webhook verification failed: ${verification.reason}`);
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }

    // Parse events
    const result = this.provider.parseWebhookEvent(ctx);

    // Process each event
    for (const event of result.events) {
      try {
        const providerCallId = event.providerCallId || "";
        const preCall = providerCallId
          ? this.manager.getCallByProviderCallId(providerCallId)
          : event.callId
            ? this.manager.getCall(event.callId)
            : undefined;
        const wasSpeaking = preCall?.state === "speaking";

        this.manager.processEvent(event);

        // Auto-respond for provider webhook transcript events (Telnyx call.transcription, etc.)
        if (event.type === "call.speech") {
          const call =
            providerCallId && providerCallId.length > 0
              ? this.manager.getCallByProviderCallId(providerCallId)
              : event.callId
                ? this.manager.getCall(event.callId)
                : undefined;
          const rawText = typeof event.transcript === "string" ? event.transcript : "";
          const text = this.normalizeTranscript(rawText);

          if (call && text) {
            const callMode = call.metadata?.mode as string | undefined;
            const shouldRespond = call.direction === "inbound" || callMode === "conversation";

            if (shouldRespond) {
              if (wasSpeaking) {
                // User spoke while bot was speaking: treat as barge-in.
                this.handleBargeIn(call.callId, providerCallId, "speaking");
              }
              if (this.inFlightResponseGeneration.has(call.callId)) {
                this.maybeSupersedeInFlight(call.callId, "in-flight");
              }

              // Debounce: Telnyx can emit many incremental transcripts; respond after a quiet window.
              this.queueAutoResponse(call.callId, rawText, {
                isFinal: event.isFinal,
              });
            }
          }
        } else if (event.type === "call.ended" || event.type === "call.error") {
          const call =
            providerCallId && providerCallId.length > 0
              ? this.manager.getCallByProviderCallId(providerCallId)
              : event.callId
                ? this.manager.getCall(event.callId)
                : undefined;
          if (call) {
            this.clearResponseState(call.callId);
          }
        }
      } catch (err) {
        console.error(`[voice-call] Error processing event ${event.type}:`, err);
      }
    }

    // Send response
    res.statusCode = result.statusCode || 200;

    if (result.providerResponseHeaders) {
      for (const [key, value] of Object.entries(result.providerResponseHeaders)) {
        res.setHeader(key, value);
      }
    }

    res.end(result.providerResponseBody || "OK");
  }

  /**
   * Read request body as string with timeout protection.
   */
  private readBody(
    req: http.IncomingMessage,
    maxBytes: number,
    timeoutMs = 30_000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => {
          const err = new Error("Request body timeout");
          req.destroy(err);
          reject(err);
        });
      }, timeoutMs);

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      req.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          finish(() => {
            req.destroy();
            reject(new Error("PayloadTooLarge"));
          });
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => finish(() => resolve(Buffer.concat(chunks).toString("utf-8"))));
      req.on("error", (err) => finish(() => reject(err)));
      req.on("close", () => finish(() => reject(new Error("Connection closed"))));
    });
  }

  /**
   * Handle auto-response for inbound calls using the agent system.
   * Supports tool calling for richer voice interactions.
   */
  private async handleInboundResponse(
    callId: string,
    userMessage: string,
    normalizedUserMessage: string,
    generation: number,
  ): Promise<void> {
    const clearInFlight = () => {
      const inFlightGeneration = this.inFlightResponseGeneration.get(callId);
      if (inFlightGeneration === generation) {
        this.inFlightResponseGeneration.delete(callId);
      }
    };

    const currentGeneration = this.getResponseGeneration(callId);
    if (currentGeneration !== generation) {
      console.log(
        `[voice-call] Discarding response generation ${generation} (current=${currentGeneration}) for ${callId}`,
      );
      clearInFlight();
      return;
    }

    // Get call context for conversation history
    const call = this.manager.getCall(callId);
    if (!call) {
      console.warn(`[voice-call] Call ${callId} not found for auto-response`);
      clearInFlight();
      return;
    }

    console.log(
      `[voice-call] Auto-responding to call ${callId} (${call.direction}): "${userMessage}"`,
    );

    if (!this.coreConfig) {
      console.warn("[voice-call] Core config missing; skipping auto-response");
      clearInFlight();
      return;
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

      if (result.error) {
        console.error(`[voice-call] Response generation error: ${result.error}`);
        return;
      }

      if (!result.text) {
        console.warn(`[voice-call] Response generation returned no text`);
        return;
      }

      if (result.text) {
        const latestGeneration = this.getResponseGeneration(callId);
        if (latestGeneration !== generation) {
          console.log(
            `[voice-call] Discarding stale response generation ${generation} (current=${latestGeneration}) for ${callId}`,
          );
          return;
        }

        console.log(`[voice-call] AI response: "${result.text}"`);
        const speakResult = await this.manager.speak(callId, result.text);
        if (speakResult.success) {
          this.lastRespondedText.set(callId, normalizedUserMessage);
          this.lastRespondedAt.set(callId, Date.now());
        } else {
          console.warn(`[voice-call] Failed to speak auto-response: ${speakResult.error}`);
        }
      }
    } catch (err) {
      console.error(`[voice-call] Auto-response error:`, err);
    } finally {
      clearInFlight();
    }
  }

  private normalizeTranscript(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  private normalizeForComparison(text: string): string {
    return this.normalizeTranscript(text).toLowerCase().replace(/[^\p{L}\p{N}'\s]+/gu, " ").trim();
  }

  private isTinyTranscript(normalized: string): boolean {
    if (!normalized) {
      return true;
    }
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return true;
    }
    if (words.length === 1 && this.tinyWords.has(words[0])) {
      return true;
    }
    if (words.length === 1 && words[0].length <= 1) {
      return true;
    }
    return false;
  }

  private isCompleteishTranscript(raw: string, normalized: string): boolean {
    const words = normalized.split(/\s+/).filter(Boolean);
    const wordCount = words.length;
    const charCount = normalized.length;
    if (wordCount < 3 || charCount < 10) {
      return false;
    }
    const endsWithPunct = /[?.!]$/.test(raw.trim());
    if (endsWithPunct) {
      return true;
    }
    if (charCount >= 20) {
      return true;
    }
    const first = words[0];
    if (first && this.questionStarters.has(first)) {
      return true;
    }
    for (const word of words) {
      if (this.commonVerbs.has(word)) {
        return true;
      }
    }
    return false;
  }

  private scoreTranscript(raw: string, normalized: string, isFinal: boolean): number {
    const words = normalized.split(/\s+/).filter(Boolean);
    const wordCount = words.length;
    const charCount = normalized.length;
    const endsWithPunct = /[?.!]$/.test(raw.trim());
    const first = words[0];
    const hasQuestionStarter = first ? this.questionStarters.has(first) : false;
    const hasVerb = words.some((word) => this.commonVerbs.has(word));

    let score = 0;
    score += wordCount * 10;
    score += Math.min(charCount, 120) * 0.6;
    if (isFinal) {
      score += 40;
    }
    if (endsWithPunct) {
      score += 10;
    }
    if (hasQuestionStarter) {
      score += 6;
    }
    if (hasVerb) {
      score += 6;
    }
    return score;
  }

  private logTranscriptSuppressed(
    callId: string,
    reason: string,
    text: string,
    extra?: Record<string, string | number | boolean>,
  ): void {
    const preview = this.normalizeTranscript(text).slice(0, 120);
    const meta = extra
      ? ` ${Object.entries(extra)
          .map(([key, value]) => `${key}=${value}`)
          .join(" ")}`
      : "";
    console.log(
      `[voice-call] Suppressing transcript for ${callId} (reason=${reason}${meta}): "${preview}"`,
    );
  }

  private isDuplicateTranscript(callId: string, normalized: string): boolean {
    const last = this.lastRespondedText.get(callId);
    if (!last || last !== normalized) {
      return false;
    }
    const lastAt = this.lastRespondedAt.get(callId) ?? 0;
    return Date.now() - lastAt < this.duplicateResponseWindowMs;
  }

  private isInCooldown(callId: string): boolean {
    const lastAt = this.lastRespondedAt.get(callId);
    if (!lastAt) {
      return false;
    }
    return Date.now() - lastAt < this.responseCooldownMs;
  }

  private maybeSupersedeInFlight(callId: string, reason: string): void {
    const inFlightGeneration = this.inFlightResponseGeneration.get(callId);
    if (inFlightGeneration === undefined) {
      return;
    }
    const currentGeneration = this.getResponseGeneration(callId);
    if (currentGeneration > inFlightGeneration) {
      return;
    }
    const next = this.bumpResponseGeneration(callId);
    console.log(
      `[voice-call] New turn while response in-flight for ${callId}; superseding gen=${inFlightGeneration} -> ${next} (reason=${reason})`,
    );
  }

  private getResponseGeneration(callId: string): number {
    return this.responseGeneration.get(callId) ?? 0;
  }

  private bumpResponseGeneration(callId: string): number {
    const next = this.getResponseGeneration(callId) + 1;
    this.responseGeneration.set(callId, next);
    return next;
  }

  private clearPendingResponse(callId: string): void {
    const timer = this.pendingResponseTimers.get(callId);
    if (timer) {
      clearTimeout(timer);
    }
    this.pendingResponseTimers.delete(callId);
    this.pendingResponseText.delete(callId);
    this.pendingResponseIsFinal.delete(callId);
    this.pendingResponseNormalized.delete(callId);
    this.pendingResponseScore.delete(callId);
    this.pendingResponseGeneration.delete(callId);
  }

  private clearResponseState(callId: string): void {
    this.clearPendingResponse(callId);
    this.inFlightResponseGeneration.delete(callId);
    this.lastRespondedText.delete(callId);
    this.lastRespondedAt.delete(callId);
    this.responseGeneration.delete(callId);
  }

  private handleBargeIn(callId: string, providerCallId?: string, reason?: string): void {
    const next = this.bumpResponseGeneration(callId);
    this.clearPendingResponse(callId);
    if (this.provider.name === "twilio" && providerCallId) {
      (this.provider as TwilioProvider).clearTtsQueue(providerCallId);
    }
    if (reason) {
      console.log(`[voice-call] Barge-in detected for ${callId} (reason=${reason}, gen=${next})`);
    }
    // Telnyx has no exposed "stop speak" in this extension; we at least cancel local pipeline.
  }

  private schedulePendingResponse(callId: string, delayMs?: number): void {
    const existing = this.pendingResponseTimers.get(callId);
    if (existing) {
      clearTimeout(existing);
    }

    const effectiveFinal = this.pendingResponseIsFinal.get(callId) ?? false;
    const debounceMs =
      delayMs ?? (effectiveFinal ? this.responseDebounceMsFinal : this.responseDebounceMsNonFinal);

    const timer = setTimeout(() => {
      const inFlightGeneration = this.inFlightResponseGeneration.get(callId);
      if (inFlightGeneration !== undefined) {
        const latest = this.pendingResponseText.get(callId) || "";
        const preview = this.normalizeTranscript(latest).slice(0, 120);
        console.log(
          `[voice-call] Deferring response for ${callId} due to in-flight generation ${inFlightGeneration}: "${preview}"`,
        );
        this.schedulePendingResponse(callId, this.inFlightRetryMs);
        return;
      }

      this.pendingResponseTimers.delete(callId);
      const pendingGeneration = this.pendingResponseGeneration.get(callId);
      this.pendingResponseGeneration.delete(callId);
      const latest = this.pendingResponseText.get(callId) || "";
      const latestFinal = this.pendingResponseIsFinal.get(callId) ?? false;
      this.pendingResponseText.delete(callId);
      this.pendingResponseIsFinal.delete(callId);
      this.pendingResponseNormalized.delete(callId);
      this.pendingResponseScore.delete(callId);

      if (pendingGeneration === undefined) {
        return;
      }
      if (this.getResponseGeneration(callId) !== pendingGeneration) {
        return;
      }
      if (this.isInCooldown(callId)) {
        this.logTranscriptSuppressed(callId, "cooldown", latest, { isFinal: latestFinal });
        return;
      }

      const latestNormalized = this.normalizeForComparison(latest);
      if (!latestNormalized || this.isTinyTranscript(latestNormalized)) {
        this.logTranscriptSuppressed(callId, "too-short", latest, {
          isFinal: latestFinal,
        });
        return;
      }
      if (this.isDuplicateTranscript(callId, latestNormalized)) {
        this.logTranscriptSuppressed(callId, "duplicate", latest, {
          isFinal: latestFinal,
        });
        return;
      }

      if (!latestFinal && !this.isCompleteishTranscript(latest, latestNormalized)) {
        this.logTranscriptSuppressed(callId, "incomplete", latest);
        return;
      }

      this.inFlightResponseGeneration.set(callId, pendingGeneration);
      this.handleInboundResponse(callId, latest, latestNormalized, pendingGeneration).catch(
        (err) => {
          console.warn(`[voice-call] Failed to auto-respond:`, err);
        },
      );
    }, debounceMs);

    this.pendingResponseTimers.set(callId, timer);
  }

  private queueAutoResponse(
    callId: string,
    rawText: string,
    options?: {
      isFinal?: boolean;
    },
  ): void {
    if (this.inFlightResponseGeneration.has(callId)) {
      this.maybeSupersedeInFlight(callId, "new-turn");
    }

    if (this.isInCooldown(callId)) {
      this.logTranscriptSuppressed(callId, "cooldown", rawText);
      return;
    }

    const cleaned = this.normalizeTranscript(rawText);
    if (!cleaned) {
      this.logTranscriptSuppressed(callId, "empty", rawText);
      return;
    }

    const normalized = this.normalizeForComparison(cleaned);
    if (!normalized || this.isTinyTranscript(normalized)) {
      this.logTranscriptSuppressed(callId, "too-short", cleaned);
      return;
    }
    if (this.isDuplicateTranscript(callId, normalized)) {
      this.logTranscriptSuppressed(callId, "duplicate", cleaned);
      return;
    }

    const incomingFinal = options?.isFinal === true;
    const incomingScore = this.scoreTranscript(cleaned, normalized, incomingFinal);
    const bestScore = this.pendingResponseScore.get(callId);
    const bestNormalized = this.pendingResponseNormalized.get(callId);
    const bestLength = bestNormalized ? bestNormalized.length : 0;
    const bestFinal = this.pendingResponseIsFinal.get(callId) ?? false;

    let shouldReplace = false;
    if (bestScore === undefined) {
      shouldReplace = true;
    } else if (incomingScore > bestScore) {
      shouldReplace = true;
    } else if (incomingScore === bestScore && normalized.length > bestLength) {
      shouldReplace = true;
    } else if (bestNormalized === normalized && incomingFinal && !bestFinal) {
      shouldReplace = true;
    }

    if (shouldReplace) {
      this.pendingResponseText.set(callId, cleaned);
      this.pendingResponseNormalized.set(callId, normalized);
      this.pendingResponseIsFinal.set(callId, incomingFinal);
      this.pendingResponseScore.set(callId, incomingScore);
    }

    let generation = this.pendingResponseGeneration.get(callId);
    if (generation === undefined) {
      generation = this.getResponseGeneration(callId);
      this.pendingResponseGeneration.set(callId, generation);
    }

    const existing = this.pendingResponseTimers.get(callId);
    if (existing && !shouldReplace) {
      return;
    }
    this.schedulePendingResponse(callId);
  }
}

/**
 * Resolve the current machine's Tailscale DNS name.
 */
export type TailscaleSelfInfo = {
  dnsName: string | null;
  nodeId: string | null;
};

/**
 * Run a tailscale command with timeout, collecting stdout.
 */
function runTailscaleCommand(
  args: string[],
  timeoutMs = 2500,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn("tailscale", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    proc.stdout.on("data", (data) => {
      stdout += data;
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ code: -1, stdout: "" });
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout });
    });
  });
}

export async function getTailscaleSelfInfo(): Promise<TailscaleSelfInfo | null> {
  const { code, stdout } = await runTailscaleCommand(["status", "--json"]);
  if (code !== 0) {
    return null;
  }

  try {
    const status = JSON.parse(stdout);
    return {
      dnsName: status.Self?.DNSName?.replace(/\.$/, "") || null,
      nodeId: status.Self?.ID || null,
    };
  } catch {
    return null;
  }
}

export async function getTailscaleDnsName(): Promise<string | null> {
  const info = await getTailscaleSelfInfo();
  return info?.dnsName ?? null;
}

export async function setupTailscaleExposureRoute(opts: {
  mode: "serve" | "funnel";
  path: string;
  localUrl: string;
}): Promise<string | null> {
  const dnsName = await getTailscaleDnsName();
  if (!dnsName) {
    console.warn("[voice-call] Could not get Tailscale DNS name");
    return null;
  }

  const { code } = await runTailscaleCommand([
    opts.mode,
    "--bg",
    "--yes",
    "--set-path",
    opts.path,
    opts.localUrl,
  ]);

  if (code === 0) {
    const publicUrl = `https://${dnsName}${opts.path}`;
    console.log(`[voice-call] Tailscale ${opts.mode} active: ${publicUrl}`);
    return publicUrl;
  }

  console.warn(`[voice-call] Tailscale ${opts.mode} failed`);
  return null;
}

export async function cleanupTailscaleExposureRoute(opts: {
  mode: "serve" | "funnel";
  path: string;
}): Promise<void> {
  await runTailscaleCommand([opts.mode, "off", opts.path]);
}

/**
 * Setup Tailscale serve/funnel for the webhook server.
 * This is a helper that shells out to `tailscale serve` or `tailscale funnel`.
 */
export async function setupTailscaleExposure(config: VoiceCallConfig): Promise<string | null> {
  if (config.tailscale.mode === "off") {
    return null;
  }

  const mode = config.tailscale.mode === "funnel" ? "funnel" : "serve";
  // Include the path suffix so tailscale forwards to the correct endpoint
  // (tailscale strips the mount path prefix when proxying)
  const localUrl = `http://127.0.0.1:${config.serve.port}${config.serve.path}`;
  return setupTailscaleExposureRoute({
    mode,
    path: config.tailscale.path,
    localUrl,
  });
}

/**
 * Cleanup Tailscale serve/funnel.
 */
export async function cleanupTailscaleExposure(config: VoiceCallConfig): Promise<void> {
  if (config.tailscale.mode === "off") {
    return;
  }

  const mode = config.tailscale.mode === "funnel" ? "funnel" : "serve";
  await cleanupTailscaleExposureRoute({ mode, path: config.tailscale.path });
}
