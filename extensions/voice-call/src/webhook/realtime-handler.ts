import http from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { type WebSocket, Server as WebSocketServer } from "ws";
import type { VoiceCallRealtimeConfig } from "../config.js";
import type { CoreConfig } from "../core-bridge.js";
import type { CallManager } from "../manager.js";
import {
  OpenAIRealtimeVoiceBridge,
  type RealtimeTool,
} from "../providers/openai-realtime-voice.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { NormalizedEvent } from "../types.js";
import type { WebhookResponsePayload } from "../webhook.js";

export type ToolHandlerFn = (args: unknown, callId: string) => Promise<unknown>;

/**
 * Handles inbound voice calls bridged directly to the OpenAI Realtime API.
 *
 * Responsibilities:
 * - Accept WebSocket upgrades from Twilio Media Streams at the /realtime path
 * - Return TwiML <Connect><Stream> payload for the initial HTTP webhook
 * - Register each call with CallManager (appears in voice status/history)
 * - Route tool calls to registered handlers (Phase 5 tool framework)
 *
 * Provider coupling: this class currently speaks the Twilio Media Streams
 * WebSocket protocol directly (μ-law audio, streamSid/callSid, start/media/
 * mark/stop events) and emits Twilio TwiML. The OpenAI bridge itself is
 * provider-agnostic. If a second provider needs realtime support, the right
 * refactor is to extract a RealtimeMediaAdapter interface (buildStreamPayload +
 * handleWebSocketUpgrade + MediaStreamCallbacks) so the bridge and call-manager
 * wiring can be reused without duplicating the OpenAI session logic.
 */
/** How long (ms) a stream token remains valid after TwiML is issued. */
const STREAM_TOKEN_TTL_MS = 30_000;

export class RealtimeCallHandler {
  private toolHandlers = new Map<string, ToolHandlerFn>();
  /** One-time tokens issued per TwiML response; consumed on WS upgrade. */
  private pendingStreamTokens = new Map<string, number>();

  constructor(
    private config: VoiceCallRealtimeConfig,
    private manager: CallManager,
    private provider: VoiceCallProvider,
    private coreConfig: CoreConfig | null,
    /** Pre-resolved OpenAI API key (falls back to OPENAI_API_KEY env at call time) */
    private openaiApiKey?: string,
  ) {}

  /**
   * Handle a WebSocket upgrade request from Twilio for a realtime media stream.
   * Called from VoiceCallWebhookServer's upgrade handler when isRealtimeWebSocketUpgrade() is true.
   *
   * Validates the one-time stream token embedded in the URL by buildTwiMLPayload before
   * accepting the upgrade. This ensures the WS connection was preceded by a properly
   * Twilio-signed POST webhook — the token is only issued after verifyWebhook passes.
   */
  handleWebSocketUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", "wss://localhost");
    const token = url.searchParams.get("token");
    if (!token || !this.consumeStreamToken(token)) {
      console.warn("[voice-call] Rejecting WS upgrade: missing or invalid stream token");
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const wss = new WebSocketServer({ noServer: true });
    wss.handleUpgrade(request, socket, head, (ws) => {
      let bridge: OpenAIRealtimeVoiceBridge | null = null;
      let initialized = false;

      ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          if (!initialized && msg.event === "start") {
            initialized = true;
            const startData = msg.start as Record<string, string> | undefined;
            const streamSid = startData?.streamSid || "unknown";
            const callSid = startData?.callSid || "unknown";
            bridge = this.handleCall(streamSid, callSid, ws);
          } else if (bridge) {
            const mediaData = msg.media as Record<string, unknown> | undefined;
            if (msg.event === "media" && mediaData?.payload) {
              bridge.sendAudio(Buffer.from(mediaData.payload as string, "base64"));
              if (mediaData.timestamp) {
                bridge.setMediaTimestamp(Number(mediaData.timestamp));
              }
            } else if (msg.event === "mark") {
              bridge.acknowledgeMark();
            } else if (msg.event === "stop") {
              bridge.close();
            }
          }
        } catch (err) {
          console.error("[voice-call] Error parsing WS message:", err);
        }
      });

      ws.on("close", () => {
        bridge?.close();
      });
    });
  }

  /**
   * Build the TwiML <Connect><Stream> response payload for a realtime call.
   * The WebSocket URL is derived from the incoming request host so no hostname
   * is hardcoded. A one-time stream token is embedded in the URL and validated
   * by handleWebSocketUpgrade to prevent unauthenticated WS connections.
   */
  buildTwiMLPayload(req: http.IncomingMessage): WebhookResponsePayload {
    const host = req.headers.host || "localhost:8443";
    const token = this.issueStreamToken();
    const wsUrl = `wss://${host}/voice/stream/realtime?token=${token}`;
    console.log(`[voice-call] Returning realtime TwiML with WebSocket: wss://${host}/voice/stream/realtime`);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/xml" },
      body: twiml,
    };
  }

  /**
   * Register a named tool handler to be called when the model invokes a function.
   * Must be called before calls begin.
   *
   * @param name - Function name as declared in config.realtime.tools
   * @param fn   - Async handler receiving (parsedArgs, internalCallId); return value
   *               is submitted back to the model as the tool result.
   */
  registerToolHandler(name: string, fn: ToolHandlerFn): void {
    this.toolHandlers.set(name, fn);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /** Generate a single-use stream token valid for STREAM_TOKEN_TTL_MS. */
  private issueStreamToken(): string {
    const token = randomUUID();
    this.pendingStreamTokens.set(token, Date.now() + STREAM_TOKEN_TTL_MS);
    // Evict expired tokens to prevent unbounded growth if calls are abandoned
    for (const [t, expiry] of this.pendingStreamTokens) {
      if (Date.now() > expiry) this.pendingStreamTokens.delete(t);
    }
    return token;
  }

  /** Consume a stream token. Returns true if valid and not yet used. */
  private consumeStreamToken(token: string): boolean {
    const expiry = this.pendingStreamTokens.get(token);
    if (expiry === undefined) return false;
    this.pendingStreamTokens.delete(token);
    return Date.now() <= expiry;
  }

  /**
   * Create and start the OpenAI Realtime bridge for a single call session.
   * Registers the call with CallManager so it appears in status/history.
   * Returns the bridge (or null on fatal config error).
   */
  private handleCall(
    streamSid: string,
    callSid: string,
    ws: WebSocket,
  ): OpenAIRealtimeVoiceBridge | null {
    const apiKey = this.openaiApiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("[voice-call] No OpenAI API key for realtime call (set streaming.openaiApiKey or OPENAI_API_KEY)");
      ws.close(1011, "No API key");
      return null;
    }

    const callId = this.registerCallInManager(callSid);
    console.log(`[voice-call] Realtime call: streamSid=${streamSid}, callSid=${callSid}, callId=${callId}`);

    // Declare as null first so closures can capture the reference before bridge is created.
    // By the time any callback fires, bridge will be fully assigned.
    let bridge: OpenAIRealtimeVoiceBridge | null = null;

    bridge = new OpenAIRealtimeVoiceBridge({
      apiKey,
      model: this.config.model,
      voice: this.config.voice,
      instructions: this.config.instructions,
      temperature: this.config.temperature,
      vadThreshold: this.config.vadThreshold,
      silenceDurationMs: this.config.silenceDurationMs,
      prefixPaddingMs: this.config.prefixPaddingMs,
      tools: this.config.tools as RealtimeTool[],

      onAudio: (muLaw) => {
        ws.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: muLaw.toString("base64") },
          }),
        );
      },

      onClearAudio: () => {
        ws.send(JSON.stringify({ event: "clear", streamSid }));
      },

      onTranscript: (role, text, isFinal) => {
        if (isFinal) {
          // Emit user speech through the manager for transcript persistence
          if (role === "user") {
            const event: NormalizedEvent = {
              id: `realtime-speech-${callSid}-${Date.now()}`,
              type: "call.speech",
              callId,
              providerCallId: callSid,
              timestamp: Date.now(),
              transcript: text,
              isFinal: true,
            };
            this.manager.processEvent(event);
          }
        }
      },

      onToolCall: (toolEvent) => {
        if (bridge) {
          void this.executeToolCall(
            bridge,
            callId,
            toolEvent.callId,
            toolEvent.name,
            toolEvent.args,
          );
        }
      },

      onReady: () => {
        bridge?.triggerGreeting();
      },

      onError: (err) => {
        console.error("[voice-call] Realtime error:", err.message);
      },

      onClose: () => {
        this.endCallInManager(callSid, callId);
      },
    });

    bridge.connect().catch((err: Error) => {
      console.error("[voice-call] Failed to connect realtime bridge:", err);
      ws.close(1011, "Failed to connect");
    });

    // Acknowledge the stream connection (mirrors Twilio Media Streams protocol)
    ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));

    return bridge;
  }

  /**
   * Emit synthetic NormalizedEvents to register the call with CallManager.
   * Returns the internal callId generated by the manager.
   *
   * Tested directly via `as unknown as` cast — the logic is non-trivial
   * enough to warrant unit testing without promoting to a public method.
   */
  private registerCallInManager(callSid: string): string {
    const now = Date.now();
    const baseFields = {
      providerCallId: callSid,
      timestamp: now,
      direction: "inbound" as const,
    };

    // call.initiated causes the manager to auto-create the call record
    // (see manager/events.ts createWebhookCall path)
    this.manager.processEvent({
      id: `realtime-initiated-${callSid}`,
      callId: callSid,
      type: "call.initiated",
      ...baseFields,
    });

    // Clear inboundGreeting from the call record before call.answered fires.
    // The realtime bridge owns all voice output; the TTS greeting path would
    // fail anyway because provider state is never initialized for realtime calls.
    const callRecord = this.manager.getCallByProviderCallId(callSid);
    if (callRecord?.metadata) {
      delete callRecord.metadata.initialMessage;
    }

    this.manager.processEvent({
      id: `realtime-answered-${callSid}`,
      callId: callSid,
      type: "call.answered",
      ...baseFields,
    });

    return callRecord?.callId ?? callSid;
  }

  private endCallInManager(callSid: string, callId: string): void {
    this.manager.processEvent({
      id: `realtime-ended-${callSid}-${Date.now()}`,
      type: "call.ended",
      callId,
      providerCallId: callSid,
      timestamp: Date.now(),
      reason: "completed",
    });
  }

  /**
   * Dispatch a tool call from the Realtime API to the registered handler.
   * Submits the result (or an error object) back to the bridge.
   *
   * Tested directly via `as unknown as` cast — the routing/error logic is
   * worth unit testing without exposing the method publicly.
   */
  private async executeToolCall(
    bridge: OpenAIRealtimeVoiceBridge,
    callId: string,
    bridgeCallId: string,
    name: string,
    args: unknown,
  ): Promise<void> {
    const handler = this.toolHandlers.get(name);
    let result: unknown;
    if (handler) {
      try {
        result = await handler(args, callId);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }
    } else {
      result = { error: `Tool "${name}" not available` };
    }
    bridge.submitToolResult(bridgeCallId, result);
  }
}
