import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  buildRealtimeVoiceAgentConsultWorkingResponse,
  createRealtimeVoiceBridgeSession,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import WebSocket, { WebSocketServer } from "ws";
import type {
  VoiceCallRealtimeCallerContextConfig,
  VoiceCallRealtimeConfig,
  VoiceCallRealtimeTranscriptLogConfig,
} from "../config.js";
import type { CallManager } from "../manager.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { CallRecord, NormalizedEvent } from "../types.js";
import type { WebhookResponsePayload } from "../webhook.types.js";

export type ToolHandlerContext = {
  partialUserTranscript?: string;
};
export type ToolHandlerFn = (
  args: unknown,
  callId: string,
  context: ToolHandlerContext,
) => Promise<unknown>;

const STREAM_TOKEN_TTL_MS = 30_000;
const DEFAULT_HOST = "localhost:8443";
const MAX_REALTIME_MESSAGE_BYTES = 256 * 1024;

function normalizePath(pathname: string): string {
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

function buildGreetingInstructions(
  baseInstructions: string | undefined,
  greeting: string | undefined,
): string | undefined {
  const trimmedGreeting = greeting?.trim();
  if (!trimmedGreeting) {
    return undefined;
  }
  const intro =
    "Start the call now. Begin the first spoken reply with this exact greeting phrase, then continue naturally and briefly:";
  return baseInstructions
    ? `${baseInstructions}\n\n${intro} "${trimmedGreeting}"`
    : `${intro} "${trimmedGreeting}"`;
}

function normalizePhone(value: string | undefined): string {
  return value?.replace(/\D/g, "") ?? "";
}

function resolveCallerContext(
  config: VoiceCallRealtimeCallerContextConfig,
  phone: string | undefined,
) {
  if (!config.enabled) {
    return undefined;
  }
  const normalized = normalizePhone(phone);
  if (!normalized) {
    return undefined;
  }
  return (
    config.callers[phone ?? ""] ?? config.callers[normalized] ?? config.callers[`+${normalized}`]
  );
}

function readBoundedFile(path: string | undefined, maxChars: number): string | null {
  if (!path) {
    return null;
  }
  try {
    const text = readFileSync(path, "utf8").trim();
    if (!text) {
      return null;
    }
    return text.length > maxChars ? `${text.slice(0, maxChars).trim()}\n…[trimmed]` : text;
  } catch {
    return null;
  }
}

function buildCallerContextInstructions(
  config: VoiceCallRealtimeCallerContextConfig,
  phone: string | undefined,
): string | undefined {
  if (!config.enabled) {
    return undefined;
  }
  const caller = resolveCallerContext(config, phone);
  if (!caller) {
    return config.unknownCallerInstructions;
  }
  const profile = readBoundedFile(caller.profilePath, config.maxProfileChars);
  const voiceCard = readBoundedFile(caller.voiceCardPath, config.maxVoiceCardChars);
  return [
    caller.name ? `Caller identity from verified caller ID: ${caller.name}.` : undefined,
    caller.name
      ? `Required opening: begin the first spoken reply with exactly “${
          caller.greeting?.trim() || `Hi ${caller.name}`
        }”.`
      : undefined,
    caller.instructions,
    profile || voiceCard
      ? "Compact caller memory for this live call. Use only when relevant; do not recite it. Keep privacy boundaries strict."
      : undefined,
    profile,
    voiceCard,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildRuntimeInstructions(
  baseInstructions: string,
  callerContext: VoiceCallRealtimeCallerContextConfig,
  phone: string | undefined,
): string {
  const callerInstructions = buildCallerContextInstructions(callerContext, phone);
  return callerInstructions ? `${baseInstructions}\n\n${callerInstructions}` : baseInstructions;
}

function resolveCallerGreeting(
  config: VoiceCallRealtimeCallerContextConfig,
  phone: string | undefined,
  fallbackGreeting: string | undefined,
): string | undefined {
  const caller = resolveCallerContext(config, phone);
  if (!caller?.name) {
    return fallbackGreeting;
  }
  return caller.greeting?.trim() || `Hi ${caller.name}`;
}

function resolveTranscriptLogPath(config: VoiceCallRealtimeTranscriptLogConfig): string {
  return config.path ?? join(homedir(), ".openclaw", "voice-calls", "realtime-transcripts.jsonl");
}

function appendTranscriptFragment(
  config: VoiceCallRealtimeTranscriptLogConfig,
  entry: Record<string, unknown>,
): void {
  if (!config.enabled) {
    return;
  }
  if (!config.includeInterim && entry.isFinal !== true) {
    return;
  }
  try {
    const path = resolveTranscriptLogPath(config);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Best-effort aftercare logging only; never break the live call path.
  }
}

type PendingStreamToken = {
  expiry: number;
  from?: string;
  to?: string;
  direction?: "inbound" | "outbound";
};

type CallRegistration = {
  callId: string;
  initialGreetingInstructions?: string;
};

type ActiveRealtimeVoiceBridge = RealtimeVoiceBridgeSession;

type RealtimeSpeakResult = {
  success: boolean;
  error?: string;
};

export class RealtimeCallHandler {
  private readonly toolHandlers = new Map<string, ToolHandlerFn>();
  private readonly pendingStreamTokens = new Map<string, PendingStreamToken>();
  private readonly activeBridgesByCallId = new Map<string, ActiveRealtimeVoiceBridge>();
  private readonly partialUserTranscriptsByCallId = new Map<string, string>();
  private publicOrigin: string | null = null;
  private publicPathPrefix = "";

  constructor(
    private readonly config: VoiceCallRealtimeConfig,
    private readonly manager: CallManager,
    private readonly provider: VoiceCallProvider,
    private readonly realtimeProvider: RealtimeVoiceProviderPlugin,
    private readonly providerConfig: RealtimeVoiceProviderConfig,
    private readonly servePath: string,
  ) {}

  setPublicUrl(url: string): void {
    try {
      const parsed = new URL(url);
      this.publicOrigin = parsed.host;
      const normalizedServePath = normalizePath(this.servePath);
      const normalizedPublicPath = normalizePath(parsed.pathname);
      const idx = normalizedPublicPath.indexOf(normalizedServePath);
      this.publicPathPrefix = idx > 0 ? normalizedPublicPath.slice(0, idx) : "";
    } catch {
      this.publicOrigin = null;
      this.publicPathPrefix = "";
    }
  }

  getStreamPathPattern(): string {
    return `${this.publicPathPrefix}${normalizePath(this.config.streamPath ?? "/voice/stream/realtime")}`;
  }

  buildTwiMLPayload(req: http.IncomingMessage, params?: URLSearchParams): WebhookResponsePayload {
    const host = this.publicOrigin || req.headers.host || DEFAULT_HOST;
    const rawDirection = params?.get("Direction");
    const token = this.issueStreamToken({
      from: params?.get("From") ?? undefined,
      to: params?.get("To") ?? undefined,
      direction: rawDirection?.startsWith("outbound") ? "outbound" : "inbound",
    });
    const wsUrl = `wss://${host}${this.getStreamPathPattern()}/${token}`;
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

  handleWebSocketUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "/", "wss://localhost");
    const token = url.pathname.split("/").pop() ?? null;
    const callerMeta = token ? this.consumeStreamToken(token) : null;
    if (!callerMeta) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const wss = new WebSocketServer({
      noServer: true,
      // Reject oversized realtime frames before JSON parsing or bridge setup runs.
      maxPayload: MAX_REALTIME_MESSAGE_BYTES,
    });
    wss.handleUpgrade(request, socket, head, (ws) => {
      let bridge: ActiveRealtimeVoiceBridge | null = null;
      let initialized = false;

      ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          if (!initialized && msg.event === "start") {
            initialized = true;
            const startData =
              typeof msg.start === "object" && msg.start !== null
                ? (msg.start as Record<string, unknown>)
                : undefined;
            const streamSid =
              typeof startData?.streamSid === "string" ? startData.streamSid : "unknown";
            const callSid = typeof startData?.callSid === "string" ? startData.callSid : "unknown";
            const nextBridge = this.handleCall(streamSid, callSid, ws, callerMeta);
            if (!nextBridge) {
              return;
            }
            bridge = nextBridge;
            return;
          }
          if (!bridge) {
            return;
          }
          const mediaData =
            typeof msg.media === "object" && msg.media !== null
              ? (msg.media as Record<string, unknown>)
              : undefined;
          if (msg.event === "media" && typeof mediaData?.payload === "string") {
            bridge.sendAudio(Buffer.from(mediaData.payload, "base64"));
            if (typeof mediaData.timestamp === "number") {
              bridge.setMediaTimestamp(mediaData.timestamp);
            } else if (typeof mediaData.timestamp === "string") {
              bridge.setMediaTimestamp(Number.parseInt(mediaData.timestamp, 10));
            }
            return;
          }
          if (msg.event === "mark") {
            bridge.acknowledgeMark();
            return;
          }
          if (msg.event === "stop") {
            bridge.close();
          }
        } catch (error) {
          console.error("[voice-call] realtime WS parse failed:", error);
        }
      });

      ws.on("close", () => {
        bridge?.close();
      });

      ws.on("error", (error) => {
        console.error("[voice-call] realtime WS error:", error);
      });
    });
  }

  registerToolHandler(name: string, fn: ToolHandlerFn): void {
    this.toolHandlers.set(name, fn);
  }

  speak(callId: string, instructions: string): RealtimeSpeakResult {
    const bridge = this.activeBridgesByCallId.get(callId);
    if (!bridge) {
      return { success: false, error: "No active realtime bridge for call" };
    }
    try {
      bridge.triggerGreeting(instructions);
      return { success: true };
    } catch (error) {
      return { success: false, error: formatErrorMessage(error) };
    }
  }

  private issueStreamToken(meta: Omit<PendingStreamToken, "expiry"> = {}): string {
    const token = randomUUID();
    this.pendingStreamTokens.set(token, { expiry: Date.now() + STREAM_TOKEN_TTL_MS, ...meta });
    for (const [candidate, entry] of this.pendingStreamTokens) {
      if (Date.now() > entry.expiry) {
        this.pendingStreamTokens.delete(candidate);
      }
    }
    return token;
  }

  private consumeStreamToken(token: string): Omit<PendingStreamToken, "expiry"> | null {
    const entry = this.pendingStreamTokens.get(token);
    if (!entry) {
      return null;
    }
    this.pendingStreamTokens.delete(token);
    if (Date.now() > entry.expiry) {
      return null;
    }
    return {
      from: entry.from,
      to: entry.to,
      direction: entry.direction,
    };
  }

  private handleCall(
    streamSid: string,
    callSid: string,
    ws: WebSocket,
    callerMeta: Omit<PendingStreamToken, "expiry">,
  ): ActiveRealtimeVoiceBridge | null {
    const registration = this.registerCallInManager(callSid, callerMeta);
    if (!registration) {
      ws.close(1008, "Caller rejected by policy");
      return null;
    }

    const { callId, initialGreetingInstructions } = registration;
    const runtimeInstructions = buildRuntimeInstructions(
      this.config.instructions,
      this.config.callerContext,
      callerMeta.from,
    );
    console.log(
      `[voice-call] Realtime bridge starting for call ${callId} (providerCallId=${callSid}, initialGreeting=${initialGreetingInstructions ? "queued" : "absent"})`,
    );
    let callEndEmitted = false;
    const emitCallEnd = (reason: "completed" | "error") => {
      if (callEndEmitted) {
        return;
      }
      callEndEmitted = true;
      this.endCallInManager(callSid, callId, reason);
    };

    const bridge = createRealtimeVoiceBridgeSession({
      provider: this.realtimeProvider,
      providerConfig: this.providerConfig,
      instructions: runtimeInstructions,
      tools: this.config.tools,
      initialGreetingInstructions,
      triggerGreetingOnReady: Boolean(initialGreetingInstructions),
      audioSink: {
        isOpen: () => ws.readyState === WebSocket.OPEN,
        sendAudio: (muLaw) => {
          ws.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: muLaw.toString("base64") },
            }),
          );
        },
        clearAudio: () => {
          ws.send(JSON.stringify({ event: "clear", streamSid }));
        },
        sendMark: (markName) => {
          ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: markName } }));
        },
      },
      onTranscript: (role, text, isFinal) => {
        const trimmedTranscript = text.trim();
        if (trimmedTranscript) {
          appendTranscriptFragment(this.config.transcriptLog, {
            timestamp: Date.now(),
            callId,
            providerCallId: callSid,
            streamSid,
            from: callerMeta.from,
            to: callerMeta.to,
            role,
            text: trimmedTranscript,
            isFinal,
          });
        }
        if (!isFinal) {
          if (role === "user" && text.trim()) {
            this.partialUserTranscriptsByCallId.set(callId, text);
          }
          return;
        }
        if (role === "user") {
          this.partialUserTranscriptsByCallId.delete(callId);
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
          return;
        }
        this.manager.processEvent({
          id: `realtime-bot-${callSid}-${Date.now()}`,
          type: "call.speaking",
          callId,
          providerCallId: callSid,
          timestamp: Date.now(),
          text,
        });
      },
      onToolCall: (toolEvent, session) => {
        void this.executeToolCall(
          session,
          callId,
          toolEvent.callId || toolEvent.itemId,
          toolEvent.name,
          toolEvent.args,
        );
      },
      onError: (error) => {
        console.error("[voice-call] realtime voice error:", error.message);
      },
      onClose: (reason) => {
        this.activeBridgesByCallId.delete(callId);
        this.activeBridgesByCallId.delete(callSid);
        this.partialUserTranscriptsByCallId.delete(callId);
        if (reason !== "error") {
          return;
        }
        emitCallEnd("error");
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1011, "Bridge disconnected");
        }
        void this.provider
          .hangupCall({ callId, providerCallId: callSid, reason: "error" })
          .catch((error: unknown) => {
            console.warn(
              `[voice-call] Failed to hang up realtime call ${callSid}: ${formatErrorMessage(
                error,
              )}`,
            );
          });
      },
    });
    this.activeBridgesByCallId.set(callId, bridge);
    this.activeBridgesByCallId.set(callSid, bridge);
    const closeBridge = bridge.close.bind(bridge);
    bridge.close = () => {
      this.activeBridgesByCallId.delete(callId);
      this.activeBridgesByCallId.delete(callSid);
      this.partialUserTranscriptsByCallId.delete(callId);
      closeBridge();
    };

    bridge.connect().catch((error: Error) => {
      console.error("[voice-call] Failed to connect realtime bridge:", error);
      bridge.close();
      emitCallEnd("error");
      ws.close(1011, "Failed to connect");
    });

    return bridge;
  }

  private registerCallInManager(
    callSid: string,
    callerMeta: Omit<PendingStreamToken, "expiry"> = {},
  ): CallRegistration | null {
    const timestamp = Date.now();
    const baseFields = {
      providerCallId: callSid,
      timestamp,
      direction: callerMeta.direction ?? "inbound",
      ...(callerMeta.from ? { from: callerMeta.from } : {}),
      ...(callerMeta.to ? { to: callerMeta.to } : {}),
    };

    this.manager.processEvent({
      id: `realtime-initiated-${callSid}`,
      callId: callSid,
      type: "call.initiated",
      ...baseFields,
    });

    const callRecord = this.manager.getCallByProviderCallId(callSid);
    if (!callRecord) {
      return null;
    }

    const initialGreeting = resolveCallerGreeting(
      this.config.callerContext,
      callerMeta.from,
      this.extractInitialGreeting(callRecord),
    );
    console.log(
      `[voice-call] Realtime call ${callRecord.callId} initial greeting ${initialGreeting ? "queued" : "absent"}`,
    );
    if (callRecord.metadata) {
      delete callRecord.metadata.initialMessage;
    }

    this.manager.processEvent({
      id: `realtime-answered-${callSid}`,
      callId: callSid,
      type: "call.answered",
      ...baseFields,
    });

    return {
      callId: callRecord.callId,
      initialGreetingInstructions: buildGreetingInstructions(undefined, initialGreeting),
    };
  }

  private extractInitialGreeting(call: CallRecord): string | undefined {
    return typeof call.metadata?.initialMessage === "string"
      ? call.metadata.initialMessage
      : undefined;
  }

  private endCallInManager(callSid: string, callId: string, reason: "completed" | "error"): void {
    this.manager.processEvent({
      id: `realtime-ended-${callSid}-${Date.now()}`,
      type: "call.ended",
      callId,
      providerCallId: callSid,
      timestamp: Date.now(),
      reason,
    });
  }

  private async executeToolCall(
    bridge: ActiveRealtimeVoiceBridge,
    callId: string,
    bridgeCallId: string,
    name: string,
    args: unknown,
  ): Promise<void> {
    const handler = this.toolHandlers.get(name);
    if (
      handler &&
      name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME &&
      bridge.bridge.supportsToolResultContinuation &&
      !this.config.fastContext.enabled
    ) {
      bridge.submitToolResult(
        bridgeCallId,
        buildRealtimeVoiceAgentConsultWorkingResponse("caller"),
        { willContinue: true },
      );
    }
    const result = !handler
      ? { error: `Tool "${name}" not available` }
      : await handler(args, callId, {
          partialUserTranscript: this.partialUserTranscriptsByCallId.get(callId),
        }).catch((error: unknown) => ({
          error: formatErrorMessage(error),
        }));
    bridge.submitToolResult(bridgeCallId, result);
  }
}
