import { spawn } from "node:child_process";
import http from "node:http";
import { URL } from "node:url";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk";
import type { VoiceCallConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import type { CallManager } from "./manager.js";
import type { MediaStreamConfig } from "./media-stream.js";
import { MediaStreamHandler } from "./media-stream.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { OpenAIRealtimeConversationProvider } from "./providers/openai-realtime-conversation.js";
import { OpenAIRealtimeSTTProvider } from "./providers/stt-openai-realtime.js";
import type { TwilioProvider } from "./providers/twilio.js";
import type { NormalizedEvent, WebhookContext } from "./types.js";
import { startStaleCallReaper } from "./webhook/stale-call-reaper.js";

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
  private stopStaleCallReaper: (() => void) | null = null;

  /** Media stream handler for bidirectional audio (when streaming enabled) */
  private mediaStreamHandler: MediaStreamHandler | null = null;

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

    const isConversationMode =
      this.config.streaming?.sttProvider === "openai-realtime-conversation";

    // Shared callbacks used by both STT and conversation modes
    const sharedCallbacks = {
      preStartTimeoutMs: this.config.streaming?.preStartTimeoutMs,
      maxPendingConnections: this.config.streaming?.maxPendingConnections,
      maxPendingConnectionsPerIp: this.config.streaming?.maxPendingConnectionsPerIp,
      maxConnections: this.config.streaming?.maxConnections,
      shouldAcceptStream: ({
        callId,
        token,
      }: {
        callId: string;
        streamSid: string;
        token?: string;
      }) => {
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
      onTranscript: (providerCallId: string, transcript: string) => {
        console.log(`[voice-call] Transcript for ${providerCallId}: ${transcript}`);

        // In STT mode, clear TTS queue on barge-in (user started speaking)
        // Conversation mode handles barge-in via response.cancel + clearAudio directly
        if (!isConversationMode && this.provider.name === "twilio") {
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

        // STT mode: auto-respond via Pi agent (conversation mode bypasses agent entirely)
        if (!isConversationMode) {
          const callMode = call.metadata?.mode as string | undefined;
          const shouldRespond = call.direction === "inbound" || callMode === "conversation";
          if (shouldRespond) {
            this.handleInboundResponse(call.callId, transcript).catch((err) => {
              console.warn(`[voice-call] Failed to auto-respond:`, err);
            });
          }
        }
      },
      onResponseTranscript: (providerCallId: string, transcript: string) => {
        console.log(`[voice-call] AI response for ${providerCallId}: ${transcript}`);
        const call = this.manager.getCallByProviderCallId(providerCallId);
        if (!call) return;
        const event: NormalizedEvent = {
          id: `stream-bot-transcript-${Date.now()}`,
          type: "call.bot-speech",
          callId: call.callId,
          providerCallId,
          timestamp: Date.now(),
          transcript,
        };
        this.manager.processEvent(event);
      },
      onSpeechStart: (providerCallId: string) => {
        // STT mode: clear TTS queue on barge-in
        // Conversation mode: barge-in is handled inside the provider (response.cancel + clearAudio)
        if (!isConversationMode && this.provider.name === "twilio") {
          (this.provider as TwilioProvider).clearTtsQueue(providerCallId);
        }
      },
      onPartialTranscript: (callId: string, partial: string) => {
        console.log(`[voice-call] Partial for ${callId}: ${partial}`);
      },
      onConnect: (callId: string, streamSid: string) => {
        console.log(`[voice-call] Media stream connected: ${callId} -> ${streamSid}`);
        // Register stream with provider for TTS routing (needed in STT mode)
        if (this.provider.name === "twilio") {
          (this.provider as TwilioProvider).registerCallStream(callId, streamSid);
        }

        // STT mode only: speak initial message via telephony TTS.
        // Conversation mode uses onConversationConnected to trigger the AI greeting
        // via response.create, avoiding the TwiML <Say> fallback that breaks the stream.
        if (!isConversationMode) {
          setTimeout(() => {
            this.manager.speakInitialMessage(callId).catch((err) => {
              console.warn(`[voice-call] Failed to speak initial message:`, err);
            });
          }, 500);
        }
      },
      onDisconnect: (callId: string) => {
        console.log(`[voice-call] Media stream disconnected: ${callId}`);
        // Auto-end call when media stream disconnects to prevent stuck calls
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

    let streamConfig: MediaStreamConfig;

    if (isConversationMode) {
      const conversationProvider = new OpenAIRealtimeConversationProvider({
        apiKey,
        model: this.config.streaming?.realtimeModel,
        voice: this.config.streaming?.realtimeVoice,
        systemPrompt: this.config.streaming?.realtimeSystemPrompt,
        silenceDurationMs: this.config.streaming?.silenceDurationMs,
        vadThreshold: this.config.streaming?.vadThreshold,
      });
      streamConfig = {
        conversationProvider,
        ...sharedCallbacks,
        onConversationConnected: (callId: string, _streamSid: string, session) => {
          // Get the initial message (if any) from call metadata and trigger AI greeting.
          const call = this.manager.getCallByProviderCallId(callId);
          const initialMessage = call?.metadata?.initialMessage as string | undefined;
          if (call?.metadata?.initialMessage) {
            delete call.metadata.initialMessage;
          }
          session.triggerGreeting(initialMessage);
        },
      };
    } else {
      const sttProvider = new OpenAIRealtimeSTTProvider({
        apiKey,
        model: this.config.streaming?.sttModel,
        silenceDurationMs: this.config.streaming?.silenceDurationMs,
        vadThreshold: this.config.streaming?.vadThreshold,
      });
      streamConfig = { sttProvider, ...sharedCallbacks };
    }

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
        const url = `http://${bind}:${port}${webhookPath}`;
        console.log(`[voice-call] Webhook server listening on ${url}`);
        if (this.mediaStreamHandler) {
          console.log(`[voice-call] Media stream WebSocket on ws://${bind}:${port}${streamPath}`);
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
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private getUpgradePathname(request: http.IncomingMessage): string | null {
    try {
      const host = request.headers.host || "localhost";
      return new URL(request.url || "/", `http://${host}`).pathname;
    } catch {
      return null;
    }
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
      if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
        res.statusCode = 413;
        res.end("Payload Too Large");
        return;
      }
      if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
        res.statusCode = 408;
        res.end(requestBodyErrorToText("REQUEST_BODY_TIMEOUT"));
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
    if (!verification.verifiedRequestKey) {
      console.warn("[voice-call] Webhook verification succeeded without request identity key");
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }

    // Parse events
    const result = this.provider.parseWebhookEvent(ctx, {
      verifiedRequestKey: verification.verifiedRequestKey,
    });

    // Process each event
    if (verification.isReplay) {
      console.warn("[voice-call] Replay detected; skipping event side effects");
    } else {
      for (const event of result.events) {
        try {
          this.manager.processEvent(event);
        } catch (err) {
          console.error(`[voice-call] Error processing event ${event.type}:`, err);
        }
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
    return readRequestBodyWithLimit(req, { maxBytes, timeoutMs });
  }

  /**
   * Handle auto-response for inbound calls using the agent system.
   * Supports tool calling for richer voice interactions.
   *
   * Uses streaming TTS to begin playing audio as soon as the first sentence
   * is ready, while Claude continues generating the rest of the response.
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

    try {
      const { generateVoiceResponseStream } = await import("./response-generator.js");

      // Bridge the callback-based onSentenceChunk into an async iterable so
      // speakStream can consume chunks as they arrive.  The queue holds pending
      // chunks while speakStream is busy synthesizing the previous one, and
      // signals completion via a sentinel (null) after generation finishes.
      const chunkQueue: Array<string | null> = [];
      let resolveWaiter: (() => void) | null = null;

      // Async iterable consumed by speakStream; yields sentence chunks as they
      // are pushed by onSentenceChunk, terminates when null is pushed.
      async function* sentenceIterable(): AsyncIterable<string> {
        for (;;) {
          if (chunkQueue.length === 0) {
            // Wait until a chunk (or the sentinel) is pushed.
            await new Promise<void>((resolve) => {
              resolveWaiter = resolve;
            });
          }
          const item = chunkQueue.shift();
          if (item === null) {
            // Sentinel — generation is complete.
            return;
          }
          if (item !== undefined) {
            yield item;
          }
        }
      }

      const pushChunk = (text: string): void => {
        chunkQueue.push(text);
        if (resolveWaiter) {
          const fn = resolveWaiter;
          resolveWaiter = null;
          fn();
        }
      };

      const pushDone = (): void => {
        chunkQueue.push(null);
        if (resolveWaiter) {
          const fn = resolveWaiter;
          resolveWaiter = null;
          fn();
        }
      };

      // Run generation and stream speaking concurrently.
      // speakStream consumes chunks as they arrive from onSentenceChunk.
      const [result] = await Promise.all([
        generateVoiceResponseStream({
          voiceConfig: this.config,
          coreConfig: this.coreConfig,
          callId,
          from: call.from,
          transcript: call.transcript,
          userMessage,
          onSentenceChunk: async (text: string) => {
            pushChunk(text);
          },
        }).finally(() => {
          // Signal the iterable consumer that no more chunks are coming.
          pushDone();
        }),
        this.manager.speakStream(callId, sentenceIterable()),
      ]);

      if (result.error) {
        console.error(`[voice-call] Response generation error: ${result.error}`);
        return;
      }

      if (result.text) {
        console.log(`[voice-call] AI response (streaming): "${result.text}"`);
        // Add the complete bot response to the call transcript now that we have
        // the full assembled text.  speakStream intentionally skips this because
        // it only sees chunks, not the final text.
        const liveCall = this.manager.getCall(callId);
        if (liveCall) {
          liveCall.transcript.push({
            timestamp: Date.now(),
            speaker: "bot",
            text: result.text,
            isFinal: true,
          });
        }
      }
    } catch (err) {
      console.error(`[voice-call] Auto-response error:`, err);
    }
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
