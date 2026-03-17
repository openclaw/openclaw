import http from "node:http";
import { URL } from "node:url";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText
} from "openclaw/plugin-sdk/voice-call";
import { normalizeVoiceCallConfig } from "./config.js";
import { MediaStreamHandler } from "./media-stream.js";
import { OpenAIRealtimeSTTProvider } from "./providers/stt-openai-realtime.js";
import { startStaleCallReaper } from "./webhook/stale-call-reaper.js";
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
function buildRequestUrl(requestUrl, requestHost, fallbackHost = "localhost") {
  return new URL(requestUrl ?? "/", `http://${requestHost ?? fallbackHost}`);
}
function normalizeWebhookResponse(parsed) {
  return {
    statusCode: parsed.statusCode ?? 200,
    headers: parsed.providerResponseHeaders,
    body: parsed.providerResponseBody ?? "OK"
  };
}
class VoiceCallWebhookServer {
  constructor(config, manager, provider, coreConfig) {
    this.server = null;
    this.listeningUrl = null;
    this.stopStaleCallReaper = null;
    /** Media stream handler for bidirectional audio (when streaming enabled) */
    this.mediaStreamHandler = null;
    this.config = normalizeVoiceCallConfig(config);
    this.manager = manager;
    this.provider = provider;
    this.coreConfig = coreConfig ?? null;
    if (this.config.streaming.enabled) {
      this.initializeMediaStreaming();
    }
  }
  /**
   * Get the media stream handler (for wiring to provider).
   */
  getMediaStreamHandler() {
    return this.mediaStreamHandler;
  }
  /**
   * Initialize media streaming with OpenAI Realtime STT.
   */
  initializeMediaStreaming() {
    const streaming = this.config.streaming;
    const apiKey = streaming.openaiApiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn("[voice-call] Streaming enabled but no OpenAI API key found");
      return;
    }
    const sttProvider = new OpenAIRealtimeSTTProvider({
      apiKey,
      model: streaming.sttModel,
      silenceDurationMs: streaming.silenceDurationMs,
      vadThreshold: streaming.vadThreshold
    });
    const streamConfig = {
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
          const twilio = this.provider;
          if (!twilio.isValidStreamToken(callId, token)) {
            console.warn(`[voice-call] Rejecting media stream: invalid token for ${callId}`);
            return false;
          }
        }
        return true;
      },
      onTranscript: (providerCallId, transcript) => {
        console.log(`[voice-call] Transcript for ${providerCallId}: ${transcript}`);
        if (this.provider.name === "twilio") {
          this.provider.clearTtsQueue(providerCallId);
        }
        const call = this.manager.getCallByProviderCallId(providerCallId);
        if (!call) {
          console.warn(`[voice-call] No active call found for provider ID: ${providerCallId}`);
          return;
        }
        const event = {
          id: `stream-transcript-${Date.now()}`,
          type: "call.speech",
          callId: call.callId,
          providerCallId,
          timestamp: Date.now(),
          transcript,
          isFinal: true
        };
        this.manager.processEvent(event);
        const callMode = call.metadata?.mode;
        const shouldRespond = call.direction === "inbound" || callMode === "conversation";
        if (shouldRespond) {
          this.handleInboundResponse(call.callId, transcript).catch((err) => {
            console.warn(`[voice-call] Failed to auto-respond:`, err);
          });
        }
      },
      onSpeechStart: (providerCallId) => {
        if (this.provider.name === "twilio") {
          this.provider.clearTtsQueue(providerCallId);
        }
      },
      onPartialTranscript: (callId, partial) => {
        console.log(`[voice-call] Partial for ${callId}: ${partial}`);
      },
      onConnect: (callId, streamSid) => {
        console.log(`[voice-call] Media stream connected: ${callId} -> ${streamSid}`);
        if (this.provider.name === "twilio") {
          this.provider.registerCallStream(callId, streamSid);
        }
        setTimeout(() => {
          this.manager.speakInitialMessage(callId).catch((err) => {
            console.warn(`[voice-call] Failed to speak initial message:`, err);
          });
        }, 500);
      },
      onDisconnect: (callId) => {
        console.log(`[voice-call] Media stream disconnected: ${callId}`);
        const disconnectedCall = this.manager.getCallByProviderCallId(callId);
        if (disconnectedCall) {
          console.log(
            `[voice-call] Auto-ending call ${disconnectedCall.callId} on stream disconnect`
          );
          void this.manager.endCall(disconnectedCall.callId).catch((err) => {
            console.warn(`[voice-call] Failed to auto-end call ${disconnectedCall.callId}:`, err);
          });
        }
        if (this.provider.name === "twilio") {
          this.provider.unregisterCallStream(callId);
        }
      }
    };
    this.mediaStreamHandler = new MediaStreamHandler(streamConfig);
    console.log("[voice-call] Media streaming initialized");
  }
  /**
   * Start the webhook server.
   * Idempotent: returns immediately if the server is already listening.
   */
  async start() {
    const { port, bind, path: webhookPath } = this.config.serve;
    const streamPath = this.config.streaming.streamPath;
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
          const actualPort = address && typeof address === "object" ? address.port : this.config.serve.port;
          console.log(
            `[voice-call] Media stream WebSocket on ws://${bind}:${actualPort}${streamPath}`
          );
        }
        resolve(url);
        this.stopStaleCallReaper = startStaleCallReaper({
          manager: this.manager,
          staleCallReaperSeconds: this.config.staleCallReaperSeconds
        });
      });
    });
  }
  /**
   * Stop the webhook server.
   */
  async stop() {
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
  resolveListeningUrl(bind, webhookPath) {
    const address = this.server?.address();
    if (address && typeof address === "object") {
      const host = address.address && address.address.length > 0 ? address.address : bind;
      const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      return `http://${normalizedHost}:${address.port}${webhookPath}`;
    }
    return `http://${bind}:${this.config.serve.port}${webhookPath}`;
  }
  getUpgradePathname(request) {
    try {
      return buildRequestUrl(request.url, request.headers.host).pathname;
    } catch {
      return null;
    }
  }
  normalizeWebhookPathForMatch(pathname) {
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
  isWebhookPathMatch(requestPath, configuredPath) {
    return this.normalizeWebhookPathForMatch(requestPath) === this.normalizeWebhookPathForMatch(configuredPath);
  }
  /**
   * Handle incoming HTTP request.
   */
  async handleRequest(req, res, webhookPath) {
    const payload = await this.runWebhookPipeline(req, webhookPath);
    this.writeWebhookResponse(res, payload);
  }
  async runWebhookPipeline(req, webhookPath) {
    const url = buildRequestUrl(req.url, req.headers.host);
    if (url.pathname === "/voice/hold-music") {
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/xml" },
        body: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">All agents are currently busy. Please hold.</Say>
  <Play loop="0">https://s3.amazonaws.com/com.twilio.music.classical/BusyStrings.mp3</Play>
</Response>`
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
    const ctx = {
      headers: req.headers,
      rawBody: body,
      url: url.toString(),
      method: "POST",
      query: Object.fromEntries(url.searchParams),
      remoteAddress: req.socket.remoteAddress ?? void 0
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
      verifiedRequestKey: verification.verifiedRequestKey
    });
    if (verification.isReplay) {
      console.warn("[voice-call] Replay detected; skipping event side effects");
    } else {
      this.processParsedEvents(parsed.events);
    }
    return normalizeWebhookResponse(parsed);
  }
  processParsedEvents(events) {
    for (const event of events) {
      try {
        this.manager.processEvent(event);
      } catch (err) {
        console.error(`[voice-call] Error processing event ${event.type}:`, err);
      }
    }
  }
  writeWebhookResponse(res, payload) {
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
  readBody(req, maxBytes, timeoutMs = 3e4) {
    return readRequestBodyWithLimit(req, { maxBytes, timeoutMs });
  }
  /**
   * Handle auto-response for inbound calls using the agent system.
   * Supports tool calling for richer voice interactions.
   */
  async handleInboundResponse(callId, userMessage) {
    console.log(`[voice-call] Auto-responding to inbound call ${callId}: "${userMessage}"`);
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
      const { generateVoiceResponse } = await import("./response-generator.js");
      const result = await generateVoiceResponse({
        voiceConfig: this.config,
        coreConfig: this.coreConfig,
        callId,
        from: call.from,
        transcript: call.transcript,
        userMessage
      });
      if (result.error) {
        console.error(`[voice-call] Response generation error: ${result.error}`);
        return;
      }
      if (result.text) {
        console.log(`[voice-call] AI response: "${result.text}"`);
        await this.manager.speak(callId, result.text);
      }
    } catch (err) {
      console.error(`[voice-call] Auto-response error:`, err);
    }
  }
}
export {
  VoiceCallWebhookServer
};
