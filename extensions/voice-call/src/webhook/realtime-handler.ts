import { randomUUID } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import {
  buildRealtimeVoiceAgentConsultWorkingResponse,
  buildRealtimeVoiceAgentErrorProviderResult,
  calculateMulawRms,
  createRealtimeVoiceSessionHarness,
  createSpeechThresholdGate,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  readRealtimeVoiceConsultQuestion,
  readSpeakableRealtimeVoiceToolResult,
  resolveRealtimeVoiceBargeIn,
  resolveRealtimeVoiceSessionPolicy,
  type RealtimeVoiceForcedConsultHandle,
  type RealtimeVoiceBridgeSession as ActiveRealtimeVoiceBridge,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceProviderPlugin,
  type ResolvedRealtimeVoiceProvider,
  type RealtimeVoiceSessionHarness,
} from "openclaw/plugin-sdk/realtime-voice";
import { createSubsystemLogger, sleep } from "openclaw/plugin-sdk/runtime-env";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeWebhookPath } from "openclaw/plugin-sdk/webhook-ingress";
import {
  rejectWebSocketUpgrade,
  WebSocket,
  WebSocketServer,
} from "openclaw/plugin-sdk/websocket-runtime";
import { resolveVoiceCallPublicPathPrefix, type VoiceCallRealtimeConfig } from "../config.js";
import type { CallManager } from "../manager.js";
import { REALTIME_VOICE_END_CALL_TOOL_NAME } from "../realtime-call-control.js";
import type { CallRecord, EndReason, NormalizedEvent, ToolHandlerContext } from "../types.js";
import type { WebhookResponsePayload } from "../webhook.types.js";
import { createRealtimeCallPlayback } from "./realtime-call-playback.js";
import {
  buildForcedConsultSpeechPrompt,
  buildGreetingInstructions,
  buildVerbatimGreetingInstructions,
  speakOnRealtimeBridge,
  type RealtimeCallControlResult,
} from "./realtime-call-session-control.js";
import {
  appendTranscriptText,
  resolveFinalTranscriptText,
  limitPartialUserTranscript,
} from "./realtime-transcript-text.js";
import type { StreamDisconnectLifecycle } from "./stream-disconnect-grace.js";
import { StreamFrameAdapter } from "./stream-frame-adapter.js";
import { appendRecentTalkEventMetadata } from "./talk-event-metadata.js";

type ToolHandlerFn = (
  args: unknown,
  callId: string,
  context: ToolHandlerContext,
) => Promise<unknown>;

const STREAM_TOKEN_TTL_MS = 30_000;
const DEFAULT_HOST = "localhost:8443";
const MAX_REALTIME_MESSAGE_BYTES = 256 * 1024;
const MAX_REALTIME_WS_BUFFERED_BYTES = 1024 * 1024;
const FORCED_CONSULT_FALLBACK_DELAY_MS = 200;
const FORCED_CONSULT_NATIVE_DEDUPE_MS = 2_000;
const FORCED_CONSULT_RESULT_MAX_CHARS = 1800;
const FORCED_CONSULT_REASON = "provider_final_transcript_without_openclaw_agent_consult";
const CONSULT_TRANSCRIPT_SETTLE_MS = 350;
const CONSULT_TRANSCRIPT_SETTLE_MAX_MS = 1_000;
const RECENT_FINAL_USER_TRANSCRIPT_TTL_MS = 2_000;
const BARGE_IN_REQUIRED_LOUD_CHUNKS = 2;
const CALLER_SPEECH_RMS_THRESHOLD = 0.035;
const logger = createSubsystemLogger("voice-call/realtime");

function withFallbackConsultQuestion(args: unknown, fallback: string | undefined): unknown {
  const providerQuestion = readRealtimeVoiceConsultQuestion(args);
  const question = fallback?.trim();
  if (providerQuestion) {
    if (
      question &&
      providerQuestion.length <= 40 &&
      question.length >= providerQuestion.length + 8
    ) {
      const record = asOptionalRecord(args);
      const context = normalizeOptionalString(record?.context);
      const fallbackContext = `Realtime provider supplied a shorter consult question: ${providerQuestion}`;
      return {
        ...record,
        question,
        context: context ? `${context}\n\n${fallbackContext}` : fallbackContext,
      };
    }
    return args;
  }
  if (!question) {
    return args;
  }
  return { ...asOptionalRecord(args), question };
}

type StreamSessionRequest = {
  providerName?: "twilio" | "telnyx";
  callId?: string;
  from?: string;
  to?: string;
  direction?: "inbound" | "outbound";
};

type PendingStreamToken = StreamSessionRequest & { expiry: number };

export type StreamSession = {
  token: string;
  streamUrl: string;
};

type RealtimeCallRegistration = {
  agentId: string;
  instructions: string;
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  capabilities?: ResolvedRealtimeVoiceProvider["capabilities"];
};

export type ResolveRealtimeCallRegistration = (
  call: CallRecord,
) => RealtimeCallRegistration | Promise<RealtimeCallRegistration>;

type ForcedConsultState = {
  owner: ActiveRealtimeVoiceBridge;
  handle: RealtimeVoiceForcedConsultHandle;
  promise: Promise<unknown>;
  sendSpeechPrompt: boolean;
  cancelled: boolean;
  cancel: () => void;
  completedAt?: number;
};

type UserTranscript = { text: string; raw?: string; updatedAt?: number };
type TranscriptSnapshot = { buffer: UserTranscript | undefined; text: string | undefined };
type NativeConsultTranscript = () => TranscriptSnapshot;

type UserTranscriptState = {
  partial?: UserTranscript;
  recentFinal?: UserTranscript;
  recentFinalTimer?: ReturnType<typeof setTimeout>;
};

type NativeConsultState = {
  owner: ActiveRealtimeVoiceBridge;
  readonly invocationId: string;
  startedAt: number;
  promise: Promise<unknown>;
  readonly cancelled: boolean;
  cancel: () => void;
};

function captureNativeConsultTranscript(state: UserTranscriptState): NativeConsultTranscript {
  // Keep the current utterance, including its remaining incremental ASR text.
  const buffer = state.partial ?? state.recentFinal;
  return () => ({ buffer, text: buffer?.text });
}

function clearRecentFinalUserTranscript(state: UserTranscriptState): void {
  clearTimeout(state.recentFinalTimer);
  state.recentFinalTimer = undefined;
  state.recentFinal = undefined;
}

function consumeUserTranscript(
  state: UserTranscriptState,
  consumed: TranscriptSnapshot | undefined,
): void {
  const buffer = consumed?.buffer;
  const text = consumed?.text?.trim();
  if (
    !buffer ||
    !text ||
    (buffer !== state.partial && buffer !== state.recentFinal) ||
    !buffer.text.toLowerCase().startsWith(text.toLowerCase())
  ) {
    return;
  }
  const remaining = buffer.text.slice(text.length).trimStart();
  if (remaining) {
    buffer.text = remaining;
    buffer.raw = remaining;
  } else if (buffer === state.partial) {
    state.partial = undefined;
  } else {
    clearRecentFinalUserTranscript(state);
  }
}

type RealtimeCallEndCause = "completed" | "disconnect" | "shutdown" | "inactivity" | "error";

// Each socket keeps its exact binding; the call map only grants current-generation
// record termination. Replacement can retire old audio without a late close killing its successor.
type RealtimeTelephonyBinding = {
  bridge: ActiveRealtimeVoiceBridge;
  acknowledgeCarrierMark: (markName?: string) => void;
  close: (cause?: RealtimeCallEndCause) => Promise<void>;
  endCall: () => void;
  noteMediaActivity: () => void;
  playVoicemail: (instructions: string) => Promise<void>;
  retire: () => void;
};

export class RealtimeCallHandler {
  private readonly toolHandlers = new Map<string, ToolHandlerFn>();
  private readonly pendingStreamTokens = new Map<string, PendingStreamToken>();
  private readonly activeSockets = new Set<WebSocket>();
  private readonly serverClosingSockets = new WeakSet<WebSocket>();
  private readonly activeBridgesByCallId = new Map<string, ActiveRealtimeVoiceBridge>();
  private readonly activeTelephonyBindingsByCallId = new Map<string, RealtimeTelephonyBinding>();
  private readonly forcedConsultsByCallId = new Map<string, ForcedConsultState>();
  private readonly nativeConsultsInFlightByCallId = new Map<string, NativeConsultState>();
  private readonly terminationAttempts = new Set<Promise<void>>();
  private readonly admissions = new Set<Promise<void>>();
  private closePromise: Promise<void> | null = null;
  private shutdownFailure: { error: unknown } | undefined;
  private closing = false;
  private publicOrigin: string | null = null;
  private publicPathPrefix = "";

  constructor(
    private readonly config: VoiceCallRealtimeConfig,
    private readonly manager: CallManager,
    private readonly resolveCallRegistration: ResolveRealtimeCallRegistration,
    private readonly servePath: string,
    private readonly streamDisconnectLifecycle: StreamDisconnectLifecycle,
    private readonly coreConfig?: OpenClawConfig,
    private readonly holdOpeningMaxMs?: number,
  ) {}

  setPublicUrl(url: string): void {
    try {
      const parsed = new URL(url);
      this.publicOrigin = parsed.host;
      this.publicPathPrefix = resolveVoiceCallPublicPathPrefix(parsed.pathname, this.servePath);
    } catch {
      this.publicOrigin = null;
      this.publicPathPrefix = "";
    }
  }

  getStreamPathPattern(): string {
    return `${this.publicPathPrefix}${normalizeWebhookPath(this.config.streamPath ?? "/voice/stream/realtime")}`;
  }

  buildTwiMLPayload(req: http.IncomingMessage, params?: URLSearchParams): WebhookResponsePayload {
    const rawDirection = params?.get("Direction");
    const previousOrigin = this.publicOrigin;
    if (!previousOrigin) {
      this.publicOrigin = req.headers.host ?? DEFAULT_HOST;
    }
    try {
      const { streamUrl } = this.issueStreamSession({
        providerName: "twilio",
        from: params?.get("From") ?? undefined,
        to: params?.get("To") ?? undefined,
        direction: rawDirection?.startsWith("outbound") ? "outbound" : "inbound",
      });
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;
      return {
        statusCode: 200,
        headers: { "Content-Type": "text/xml" },
        body: twiml,
      };
    } finally {
      this.publicOrigin = previousOrigin;
    }
  }

  handleWebSocketUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    // HTTP no longer owns socket errors after handing off an upgrade.
    socket.once("error", () => socket.destroy());
    if (this.closing) {
      rejectWebSocketUpgrade(socket, { status: 503 });
      return;
    }

    const url = new URL(request.url ?? "/", "wss://localhost");
    const token = url.pathname.split("/").pop() ?? null;
    const callerMeta = token ? this.consumeStreamToken(token) : null;
    if (!callerMeta) {
      rejectWebSocketUpgrade(socket, { status: 401 });
      return;
    }

    const providerName = callerMeta.providerName ?? "twilio";
    const adapter = new StreamFrameAdapter(providerName);

    const wss = new WebSocketServer({
      noServer: true,
      // Reject oversized realtime frames before JSON parsing or bridge setup runs.
      maxPayload: MAX_REALTIME_MESSAGE_BYTES,
    });
    wss.handleUpgrade(request, socket, head, (ws) => {
      this.activeSockets.add(ws);
      let telephonyBinding: RealtimeTelephonyBinding | null = null;
      let initialized = false;
      let activeCallSid = "unknown";
      let activeStreamSid = "unknown";
      let lastMediaTimestamp: number | undefined;
      let lastMediaGapWarnAt = 0;

      let admitting = false;
      const pendingFrames: Buffer[] = [];
      let pendingBytes = 0;
      const handleMessage = (data: Buffer) => {
        if (admitting) {
          pendingBytes += Math.max(1, data.byteLength);
          if (pendingBytes > MAX_REALTIME_WS_BUFFERED_BYTES) {
            ws.terminate();
            return;
          }
          pendingFrames.push(data);
          return;
        }
        try {
          const frame = adapter.parseInbound(data.toString());
          if (frame.kind === "ignored") {
            return;
          }
          if (frame.kind === "start") {
            if (initialized) {
              return;
            }
            initialized = true;
            activeCallSid = frame.providerCallId;
            activeStreamSid = frame.streamId;
            admitting = true;
            // pause() stops socket reads, but ws can still emit frames already in its receiver.
            ws.pause();
            const admission = this.handleCall(
              frame.streamId,
              frame.providerCallId,
              ws,
              callerMeta,
              adapter,
            )
              .then(async (nextBinding) => {
                telephonyBinding = nextBinding;
                if (!nextBinding) {
                  return;
                }
                if (this.closing || ws.readyState !== WebSocket.OPEN) {
                  await nextBinding.close(
                    this.serverClosingSockets.has(ws) ? "shutdown" : "disconnect",
                  );
                  return;
                }
                this.streamDisconnectLifecycle.connect(activeCallSid, activeStreamSid);
              })
              .catch((error: unknown) => {
                console.error("[voice-call] realtime admission failed:", error);
                ws.close(1011, "Failed to persist call");
              })
              .finally(() => {
                admitting = false;
                if (ws.readyState === WebSocket.OPEN && !this.closing) {
                  for (const pending of pendingFrames) {
                    handleMessage(pending);
                  }
                }
                ws.resume();
                pendingFrames.length = 0;
                pendingBytes = 0;
              });
            this.trackShutdownWork(admission, this.admissions);
            return;
          }
          if (!telephonyBinding) {
            return;
          }
          if (frame.kind === "media") {
            const audio = Buffer.from(frame.payloadBase64, "base64");
            telephonyBinding.noteMediaActivity();
            telephonyBinding.bridge.sendAudio(audio);
            if (frame.timestampMs !== undefined) {
              if (lastMediaTimestamp !== undefined) {
                const gapMs = frame.timestampMs - lastMediaTimestamp;
                const now = Date.now();
                if ((gapMs > 120 || gapMs < 0) && now - lastMediaGapWarnAt > 5_000) {
                  lastMediaGapWarnAt = now;
                  console.warn(
                    `[voice-call] realtime media timestamp gap providerCallId=${activeCallSid} gapMs=${gapMs} timestamp=${frame.timestampMs}`,
                  );
                }
              }
              lastMediaTimestamp = frame.timestampMs;
              telephonyBinding.bridge.setMediaTimestamp(frame.timestampMs);
            }
            return;
          }
          if (frame.kind === "mark") {
            telephonyBinding.acknowledgeCarrierMark(frame.name);
            telephonyBinding.bridge.acknowledgeMark(frame.name);
            return;
          }
          if (frame.kind === "error") {
            console.error(
              `[voice-call] realtime WS error frame providerCallId=${activeCallSid} code=${frame.code ?? "?"} title=${frame.title ?? ""} detail=${frame.detail ?? ""}`,
            );
            return;
          }
          if (frame.kind === "stop") {
            void telephonyBinding.close("disconnect");
          }
        } catch (error) {
          console.error("[voice-call] realtime WS parse failed:", error);
        }
      };
      ws.on("message", handleMessage);

      ws.on("close", () => {
        this.activeSockets.delete(ws);
        const reason = this.serverClosingSockets.has(ws) ? "shutdown" : "disconnect";
        if (telephonyBinding) {
          void telephonyBinding.close(reason);
        }
      });

      ws.on("error", (error) => {
        console.error("[voice-call] realtime WS error:", error);
        ws.terminate();
      });

      if (this.closing) {
        this.serverClosingSockets.add(ws);
        ws.terminate();
      }
    });
  }

  close(shutdownBarrier: Promise<unknown> = Promise.resolve()): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.closing = true;
    this.pendingStreamTokens.clear();
    const sockets = [...this.activeSockets];
    this.closePromise = Promise.allSettled([
      shutdownBarrier,
      ...sockets.map(
        (ws) =>
          new Promise<void>((resolve) => {
            if (ws.readyState === WebSocket.CLOSED) {
              resolve();
              return;
            }
            this.serverClosingSockets.add(ws);
            ws.once("close", () => resolve());
            ws.terminate();
          }),
      ),
    ])
      .then(async (results) => {
        results.push(...(await Promise.allSettled(this.admissions)));
        results.push(...(await Promise.allSettled(this.terminationAttempts)));
        this.pendingStreamTokens.clear();
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") {
          throw failure.reason;
        }
        if (this.shutdownFailure) {
          throw this.shutdownFailure.error;
        }
      })
      .finally(() => {
        this.closing = false;
        this.closePromise = null;
        this.shutdownFailure = undefined;
      });
    return this.closePromise;
  }

  private trackShutdownWork(work: Promise<void>, pending: Set<Promise<void>>): void {
    pending.add(work);
    void work.then(
      () => {
        pending.delete(work);
      },
      (error: unknown) => {
        pending.delete(work);
        // A slow shutdown barrier must not erase a cleanup failure that already settled.
        if (this.closing) {
          this.shutdownFailure ??= { error };
        }
      },
    );
  }

  registerToolHandler(name: string, fn: ToolHandlerFn): void {
    this.toolHandlers.set(name, fn);
  }

  speak(callId: string, instructions: string): RealtimeCallControlResult {
    return speakOnRealtimeBridge(this.activeBridgesByCallId, callId, instructions);
  }

  playVoicemail(callId: string, instructions: string): Promise<void> | undefined {
    return this.activeTelephonyBindingsByCallId.get(callId)?.playVoicemail(instructions);
  }

  async drainCall(callId: string): Promise<void> {
    await this.activeBridgesByCallId.get(callId)?.close();
  }

  async prepareCarrierPlayback(callId: string): Promise<void> {
    // Retire the stream grace timer before TwiML replaces it with carrier speech.
    // Closing without an end cause drains the producer while keeping the call live.
    await this.activeTelephonyBindingsByCallId.get(callId)?.close();
  }

  issueStreamSession(request: StreamSessionRequest = {}): StreamSession {
    const meta: StreamSessionRequest = {
      providerName: request.providerName ?? "twilio",
      callId: request.callId,
      from: request.from,
      to: request.to,
      direction: request.direction,
    };
    const token = randomUUID();
    const now = Date.now();
    const expiry = resolveExpiresAtMsFromDurationMs(STREAM_TOKEN_TTL_MS, { nowMs: now });
    if (expiry !== undefined) {
      this.pendingStreamTokens.set(token, { expiry, ...meta });
      const host = this.publicOrigin || DEFAULT_HOST;
      const streamPathPattern = this.getStreamPathPattern();
      const timer = setTimeout(() => {
        if (!this.pendingStreamTokens.has(token)) {
          return;
        }
        this.pendingStreamTokens.delete(token);
        if (this.closing) {
          return;
        }
        const call = meta.callId ? ` for call ${meta.callId}` : "";
        const endpoints = [meta.from ? `from ${meta.from}` : "", meta.to ? `to ${meta.to}` : ""]
          .filter(Boolean)
          .join(" ");
        const participants = endpoints ? ` (${endpoints})` : "";
        console.warn(
          `[voice-call] Realtime stream WebSocket never connected within ${STREAM_TOKEN_TTL_MS / 1000}s${call}${participants} — the provider could not reach wss://${host}${streamPathPattern}/<token>. Verify the stream path is exposed (tailscale serve/funnel --set-path).`,
        );
      }, STREAM_TOKEN_TTL_MS);
      timer.unref?.();
    }
    const host = this.publicOrigin || DEFAULT_HOST;
    const streamUrl = `wss://${host}${this.getStreamPathPattern()}/${token}`;
    return { token, streamUrl };
  }

  private consumeStreamToken(token: string): Omit<PendingStreamToken, "expiry"> | null {
    const entry = this.pendingStreamTokens.get(token);
    if (!entry) {
      return null;
    }
    this.pendingStreamTokens.delete(token);
    if (!isFutureDateTimestampMs(entry.expiry)) {
      return null;
    }
    const { expiry: _expiry, ...request } = entry;
    return request;
  }

  private async handleCall(
    streamSid: string,
    callSid: string,
    ws: WebSocket,
    callerMeta: Omit<PendingStreamToken, "expiry">,
    adapter: StreamFrameAdapter,
  ): Promise<RealtimeTelephonyBinding | null> {
    const preparedCall = await this.prepareCallInManager(callSid, callerMeta);
    if (!preparedCall) {
      ws.close(1008, "Caller rejected by policy");
      return null;
    }

    const { callRecord } = preparedCall;
    const callId = callRecord.callId;
    let callEndPromise: Promise<void> | undefined;
    const emitCallEnd = (cause: RealtimeCallEndCause): Promise<void> => {
      if (callEndPromise) {
        return callEndPromise;
      }
      const reason: EndReason =
        cause === "error" ? "error" : cause === "inactivity" ? "timeout" : "completed";
      const attempt = this.manager.endCall(callId, { reason }).then((result) => {
        if (!result.success) {
          console.warn(
            `[voice-call] Failed to end realtime call callId=${callId} providerCallId=${callSid} reason=${reason}: ${result.error ?? "unknown error"}; call remains active`,
          );
          return;
        }
        console.log(
          `[voice-call] Realtime call ended callId=${callId} providerCallId=${callSid} reason=${cause}`,
        );
      });
      callEndPromise = attempt;
      this.trackShutdownWork(attempt, this.terminationAttempts);
      return attempt;
    };

    const carrierOwnsPlayback = () =>
      Boolean(callRecord.metadata?.voicemailStatus || callRecord.metadata?.notifyStatus);
    const admissionAbandoned = () =>
      this.closing || ws.readyState !== WebSocket.OPEN || carrierOwnsPlayback();
    const abandonAdmission = async (): Promise<void> => {
      if (carrierOwnsPlayback()) {
        this.streamDisconnectLifecycle.retire(callSid, streamSid);
        ws.close(1000, "Carrier playback owns the call");
        return;
      }
      if (!this.activeBridgesByCallId.has(callId)) {
        if (this.closing || this.serverClosingSockets.has(ws)) {
          await emitCallEnd("shutdown");
        } else {
          this.streamDisconnectLifecycle.connect(callSid, streamSid);
          this.streamDisconnectLifecycle.disconnect(callSid, streamSid);
        }
      }
    };
    if (admissionAbandoned()) {
      await abandonAdmission();
      return null;
    }

    let registration: RealtimeCallRegistration;
    let sessionPolicy: ReturnType<typeof resolveRealtimeVoiceSessionPolicy>;
    try {
      registration = await this.resolveCallRegistration(callRecord);
      sessionPolicy = resolveRealtimeVoiceSessionPolicy({
        isAgentProxy: false,
        capabilities: registration.capabilities,
        configuredToolPolicy: this.config.toolPolicy,
        configuredConsultPolicy: this.config.consultPolicy === "always" ? "always" : "auto",
        requireWakeName: undefined,
        configuredWakeNames: undefined,
        cfg: this.coreConfig ?? {},
        agentId: registration.agentId,
      });
    } catch (error) {
      console.error(
        `[voice-call] Failed to resolve realtime call registration callId=${callId} providerCallId=${callSid}: ${formatErrorMessage(error)}`,
      );
      if (!this.activeBridgesByCallId.has(callId)) {
        void emitCallEnd("error");
      }
      ws.close(1011, "Check realtime configuration for routed agent");
      return null;
    }

    const { baseFields } = preparedCall;
    let initialGreeting: string | undefined;
    await this.manager.updateCallMetadata(callRecord, (metadata) => {
      if (metadata) {
        initialGreeting =
          typeof metadata.initialMessage === "string" ? metadata.initialMessage : undefined;
        delete metadata.initialMessage;
      }
      return metadata;
    });
    await this.manager.processEvent({
      id: `realtime-answered-${callSid}`,
      callId,
      type: "call.answered",
      ...baseFields,
    });
    if (admissionAbandoned()) {
      await abandonAdmission();
      return null;
    }
    if (this.manager.getCallByProviderCallId(callSid) !== callRecord) {
      ws.close(1008, "Call is no longer active");
      return null;
    }
    const previousTelephonyBinding = this.activeTelephonyBindingsByCallId.get(callId);
    const {
      agentId,
      instructions,
      provider: realtimeProvider,
      providerConfig,
      capabilities,
    } = registration;
    const { handlesAgentConsult, toolPolicy } = sessionPolicy;
    if (handlesAgentConsult) {
      console.warn(
        "[voice-call] This realtime model uses native agent delegation; hang-up is available through the call-scoped OpenClaw agent, while other custom realtime function tools remain unavailable.",
      );
    }
    const initialGreetingInstructions = handlesAgentConsult
      ? buildVerbatimGreetingInstructions(instructions, initialGreeting)
      : buildGreetingInstructions(instructions, initialGreeting);
    const isDelayedOutboundGreeting =
      handlesAgentConsult &&
      callRecord.direction === "outbound" &&
      Boolean(initialGreetingInstructions);
    // The host owns the outbound opening when it must wait for the callee (native delegation)
    // or for answering-machine detection; otherwise the bridge greets on ready as before.
    const hostOwnsOpening =
      callRecord.direction === "outbound" &&
      Boolean(initialGreetingInstructions) &&
      (handlesAgentConsult ||
        (Boolean(callRecord.metadata?.voicemailManagedByHost) &&
          callRecord.metadata?.mode !== "notify"));
    const sessionInstructions = isDelayedOutboundGreeting
      ? initialGreetingInstructions
      : instructions;
    const harness = createRealtimeVoiceSessionHarness({
      forcedConsults: {
        questionsMatch: (left, right) => Boolean(left && right && left.trim() === right.trim()),
      },
      talk: {
        sessionId: `voice-call:${callId}:realtime`,
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: realtimeProvider.id,
      },
      talkPayloads: {
        turnStarted: () => ({ callId, providerCallId: callSid }),
        turnEnded: (reason) => ({ callId, providerCallId: callSid, reason }),
        inputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
        outputAudioStarted: () => ({ callId, providerCallId: callSid }),
        outputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
        outputAudioDone: (reason) => ({ callId, providerCallId: callSid, reason }),
      },
      onTalkEvent: (event) => {
        void this.manager
          .updateCallMetadata(callRecord, (metadata) =>
            appendRecentTalkEventMetadata(metadata, event, "realtime"),
          )
          .catch((error: unknown) => {
            console.warn("[voice-call] Failed to update realtime call metadata:", error);
          });
      },
    });
    const providerHandlesInputAudioBargeIn =
      (capabilities ?? realtimeProvider.capabilities)?.handlesInputAudioBargeIn === true;
    harness.emit({
      type: "session.started",
      payload: { callId, providerCallId: callSid, streamSid },
    });
    console.log(
      `[voice-call] Realtime bridge starting for call ${callId} (providerCallId=${callSid}, initialGreeting=${initialGreetingInstructions ? "queued" : "absent"})`,
    );

    const speechDetector = createSpeechThresholdGate({
      rmsThreshold: CALLER_SPEECH_RMS_THRESHOLD,
      speechFrames: BARGE_IN_REQUIRED_LOUD_CHUNKS,
      silenceFrames: 12,
    });
    const interruptResponseOnInputAudio =
      typeof providerConfig.interruptResponseOnInputAudio === "boolean"
        ? providerConfig.interruptResponseOnInputAudio
        : undefined;
    // Providers may close synchronously before createBridge returns; no consult can exist yet.
    let nativeConsultOwner: ActiveRealtimeVoiceBridge | undefined = undefined;
    const { audioPacer, pendingMarkAcks, outboundGreeting, audioController, activity, hostSpeech } =
      createRealtimeCallPlayback({
        ws,
        callRecord,
        callSid,
        adapter,
        harness,
        initialGreetingInstructions,
        hostOwnsOpening,
        holdOpeningMaxMs: this.holdOpeningMaxMs,
        idleHangupMs: this.config.idleHangupMs,
        getSession: () => nativeConsultOwner,
        isClosed: () => sessionClosed,
        closeForInactivity: () => {
          void telephonyBinding.close("inactivity");
        },
      });
    let sessionClosed = false;
    const userTranscriptOwner: UserTranscriptState = {};
    let transcriptPersistence = Promise.resolve();
    let transcriptFailure: { error: unknown } | undefined;
    const reportTranscriptFailure = (error: unknown) => {
      transcriptFailure ??= { error };
      console.error("[voice-call] Failed to persist realtime transcript:", error);
    };
    const drainProviderClose = async (closeProvider: () => void | Promise<void>) => {
      const failures: unknown[] = [];
      try {
        await closeProvider();
      } catch (error) {
        failures.push(error);
      }
      // Closing can emit final text, so join the latest manager write after provider disposal.
      await transcriptPersistence.catch((error: unknown) => {
        transcriptFailure ??= { error };
      });
      if (transcriptFailure) {
        failures.push(transcriptFailure.error);
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Realtime provider and transcript cleanup failed");
      }
    };
    const bridgeParams: Parameters<typeof harness.createBridge>[0] = {
      provider: realtimeProvider,
      cfg: this.coreConfig,
      agentId,
      providerConfig,
      capabilities,
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
      interruptResponseOnInputAudio,
      instructions: handlesAgentConsult
        ? `${sessionInstructions}\n\nUse native agent delegation for OpenClaw work. To end the current call, say out loud that you are hanging up and delegate; the OpenClaw agent acts on the transcript. Other custom realtime function tools are unavailable in this session.`
        : sessionInstructions,
      tools: handlesAgentConsult ? [] : this.config.tools,
      ...(handlesAgentConsult
        ? {
            runAgentConsult: async (request) => {
              const owner = nativeConsultOwner;
              request.signal?.throwIfAborted();
              const invocationId = randomUUID();
              const transcript = captureNativeConsultTranscript(userTranscriptOwner);
              activity.beginConsult();
              try {
                await transcriptPersistence;
                if (!owner || sessionClosed || !this.isActiveBridgeOwner(callId, owner)) {
                  throw new Error("Realtime call delegation owner is no longer active");
                }
                if (toolPolicy === "none") {
                  throw new Error("Agent consultation is disabled for this call");
                }
                const result = await this.executeToolCall(
                  owner,
                  callId,
                  invocationId,
                  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
                  { question: request.prompt },
                  harness.ensureTurn(),
                  harness,
                  userTranscriptOwner,
                  transcript,
                  { signal: request.signal },
                );
                request.signal?.throwIfAborted();
                if (sessionClosed || !this.isActiveBridgeOwner(callId, owner)) {
                  throw new Error("Realtime call delegation owner is no longer active");
                }
                const text = readSpeakableRealtimeVoiceToolResult(result, {
                  keys: ["text", "output"],
                  maxChars: FORCED_CONSULT_RESULT_MAX_CHARS,
                });
                if (!text) {
                  throw new Error("Agent consultation returned no spoken answer");
                }
                return { text };
              } finally {
                activity.endConsult();
              }
            },
          }
        : {}),
      initialGreetingInstructions,
      triggerGreetingOnReady: Boolean(initialGreetingInstructions) && !hostOwnsOpening,
      audioSink: audioController.audioSink,
      onTranscript: (role, text, isFinal) => {
        const owner = nativeConsultOwner;
        if (
          outboundGreeting.isBlocked() ||
          (sessionClosed && !isFinal) ||
          !owner ||
          !this.isActiveBridgeOwner(callId, owner)
        ) {
          return;
        }
        if (text.trim()) {
          outboundGreeting.claim();
          activity.noteSpeech();
        }
        const turnId = harness.ensureTurn();
        const eventType =
          role === "assistant"
            ? isFinal
              ? "output.text.done"
              : "output.text.delta"
            : isFinal
              ? "transcript.done"
              : "transcript.delta";
        const payload = role === "assistant" ? { text } : { role, text };
        harness.emit({
          type: eventType,
          turnId,
          payload,
          final: isFinal,
        });
        if (role === "user" && isFinal) {
          harness.emit({
            type: "input.audio.committed",
            turnId,
            payload: { callId, providerCallId: callSid },
            final: true,
          });
        }
        if (!isFinal) {
          if (role === "user" && text.trim()) {
            const state = userTranscriptOwner;
            const partial = (state.partial ??= { text: "" });
            partial.text = limitPartialUserTranscript(appendTranscriptText(partial.text, text));
            partial.raw = limitPartialUserTranscript(`${partial.raw ?? ""}${text}`);
            partial.updatedAt = Date.now();
            console.log(
              `[voice-call] realtime input transcript callId=${callId} providerCallId=${callSid} final=false chars=${text.trim().length} aggregateChars=${partial.text.length}`,
            );
          }
          return;
        }
        let transcript = text;
        let consultTranscript: TranscriptSnapshot | undefined;
        if (role === "user") {
          const state = userTranscriptOwner;
          transcript = resolveFinalTranscriptText({
            partial: state.partial?.text,
            rawPartial: state.partial?.raw,
            final: text,
          });
          const buffer = state.partial ?? { text: transcript };
          buffer.text = transcript;
          state.partial = undefined;
          clearRecentFinalUserTranscript(state);
          // Finalization retains the partial buffer; independently repeated speech gets a new one.
          state.recentFinal = buffer;
          consultTranscript = { buffer, text: transcript };
          const timer = setTimeout(() => {
            state.recentFinal = undefined;
            state.recentFinalTimer = undefined;
          }, RECENT_FINAL_USER_TRANSCRIPT_TTL_MS);
          timer.unref?.();
          state.recentFinalTimer = timer;
          console.log(
            `[voice-call] realtime input transcript callId=${callId} providerCallId=${callSid} final=true chars=${text.trim().length} aggregateChars=${transcript.length}`,
          );
        }
        const event: NormalizedEvent = {
          id: `realtime-${role === "user" ? "speech" : "bot"}-${callSid}-${randomUUID()}`,
          callId,
          providerCallId: callSid,
          timestamp: Date.now(),
          transcript,
          ...(role === "user"
            ? { type: "call.speech", isFinal: true }
            : { type: "call.assistant-speech" }),
        };
        transcriptPersistence = this.manager.processEvent(event).then(() => {
          if (
            role !== "user" ||
            handlesAgentConsult ||
            sessionClosed ||
            !this.isActiveBridgeOwner(callId, session)
          ) {
            return;
          }
          this.scheduleForcedAgentConsult({
            harness,
            session,
            callId,
            callSid,
            transcript,
            consultTranscript,
            userTranscriptOwner,
            clearAudio: () => {
              const clearedBytes = audioPacer.clearAudio();
              console.log(
                `[voice-call] realtime forced consult cleared outbound audio callId=${callId} providerCallId=${callSid} queuedBytes=${clearedBytes}`,
              );
            },
            beginConsultActivity: () => activity.beginConsult(),
            endConsultActivity: () => activity.endConsult(),
          });
        });
        void transcriptPersistence.catch(reportTranscriptFailure);
      },
      onToolCall: async (toolEvent, sessionLocal) => {
        const isConsult = toolEvent.name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME;
        const invocationId = toolEvent.callId || toolEvent.itemId;
        const transcript = isConsult
          ? captureNativeConsultTranscript(userTranscriptOwner)
          : undefined;
        if (isConsult) {
          activity.beginConsult();
        }
        try {
          await transcriptPersistence;
          if (sessionClosed || !this.isActiveBridgeOwner(callId, sessionLocal)) {
            return;
          }
          const turnId = harness.ensureTurn();
          harness.emit({
            type: "tool.call",
            turnId,
            itemId: toolEvent.itemId,
            callId: toolEvent.callId,
            payload: { name: toolEvent.name, args: toolEvent.args },
          });
          console.log(
            `[voice-call] realtime tool call received callId=${callId} providerCallId=${callSid} tool=${toolEvent.name}`,
          );
          await this.executeToolCall(
            sessionLocal,
            callId,
            invocationId,
            toolEvent.name,
            toolEvent.args,
            turnId,
            harness,
            userTranscriptOwner,
            transcript,
          );
        } finally {
          if (isConsult) {
            activity.endConsult();
          }
        }
      },
      onEvent: (event) => {
        if (event.direction === "client" && event.type === "session.continuity.reset") {
          // Clear current playback and cancel consult work on a provider reset.
          const turnId = harness.talk.activeTurnId;
          const owner = nativeConsultOwner;
          if (owner && this.isActiveBridgeOwner(callId, owner)) {
            userTranscriptOwner.partial = undefined;
            clearRecentFinalUserTranscript(userTranscriptOwner);
            this.cancelConsultSession(callId, owner, harness.forcedConsults, "continuity-reset");
          }
          harness.flushOutput(() => {
            audioPacer.clearAudio();
            harness.finishOutputAudio(event.type);
          });
          if (turnId) {
            harness.talk.cancelTurn({
              turnId,
              payload: { callId, providerCallId: callSid, reason: event.type },
            });
          }
          return;
        }
        if (event.type === "input_audio_buffer.speech_started" && !outboundGreeting.isBlocked()) {
          outboundGreeting.claim();
          activity.noteSpeech();
          harness.ensureTurn();
          return;
        }
        if (event.type === "input_audio_buffer.speech_stopped") {
          const turnId = harness.talk.activeTurnId;
          if (!turnId) {
            return;
          }
          harness.emit({
            type: "input.audio.committed",
            turnId,
            payload: { callId, providerCallId: callSid, source: event.type },
            final: true,
          });
          return;
        }
        if (event.type === "error") {
          harness.emit({
            type: "session.error",
            payload: { message: event.detail ?? "Realtime provider error" },
            final: true,
          });
        }
      },
      onResponseDone: (outcome) => {
        if (outcome.status === "failed" || outcome.status === "incomplete") {
          console.warn(`[voice-call] realtime response ${outcome.status}: ${outcome.message}`);
        }
      },
      onReady: (readySession) => {
        harness.emit({
          type: "session.ready",
          payload: { callId, providerCallId: callSid },
        });
        outboundGreeting.onReady(readySession);
      },
      onError: (error) => {
        console.error("[voice-call] realtime voice error:", error.message);
        harness.emit({
          type: "session.error",
          payload: { message: error.message },
          final: true,
        });
      },
      onClose: (reason) => {
        harness.finishOutputAudio(reason);
        harness.emit({
          type: "session.closed",
          payload: { reason },
          final: true,
        });
        const owner = nativeConsultOwner;
        if (!owner) {
          // Providers begin producing events after connect(), not during construction.
          return;
        }
        if (sessionClosed) {
          if (reason === "error") {
            this.streamDisconnectLifecycle.retire(callSid, streamSid);
            if (ws.readyState === WebSocket.OPEN) {
              ws.close(1011, "Bridge disconnected");
            }
          }
          return;
        }
        const ownsCallState = this.isActiveBridgeOwner(callId, owner);
        // Carrier teardown already owns its outcome; a provider-ended call still needs hangup.
        if (reason === "completed" && !ownsCallState) {
          return;
        }
        if (ownsCallState) {
          void closeBinding(reason);
        }
        this.streamDisconnectLifecycle.retire(callSid, streamSid);
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(reason === "error" ? 1011 : 1000, "Bridge disconnected");
        }
      },
    };
    let candidate: ActiveRealtimeVoiceBridge | undefined;
    try {
      candidate = harness.createBridge(bridgeParams);
    } catch (error) {
      console.error("[voice-call] Failed to create realtime bridge:", error);
    }
    if (!candidate) {
      harness.close();
      audioPacer.close();
      outboundGreeting.close();
      hostSpeech.close();
      activity.close();
      if (!this.activeBridgesByCallId.has(callId)) {
        void emitCallEnd("error");
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1011, "Failed to create realtime bridge");
      }
      return null;
    }
    const session = candidate;
    nativeConsultOwner = session;
    const localBargeIn =
      !(session.bridge.handlesInputAudioBargeIn ?? providerHandlesInputAudioBargeIn) &&
      resolveRealtimeVoiceBargeIn({
        configuredBargeIn: undefined,
        interruptResponseOnInputAudio,
        capabilities,
        outputAudioMode: session.bridge.outputAudioMode,
      });
    const sendAudioToSession = session.sendAudio.bind(session);
    session.sendAudio = (audio) => {
      if (sessionClosed) {
        return;
      }
      outboundGreeting.noteInputAudio(audio);
      if (outboundGreeting.isBlocked() || hostSpeech.isActive()) {
        return;
      }
      const inputRms = calculateMulawRms(audio);
      if (inputRms >= CALLER_SPEECH_RMS_THRESHOLD) {
        activity.noteSpeech();
      }
      if (speechDetector.accept({ rms: inputRms, peak: 0 })) {
        outboundGreeting.claim();
        console.log(
          `[voice-call] realtime local speech detected callId=${callId} providerCallId=${callSid}`,
        );
        if (localBargeIn && !activity.isPaused()) {
          audioController.cancelOutputAudioForBargeIn("local", (audioPlaybackActive) => {
            session.handleBargeIn({ audioPlaybackActive });
          });
        }
      }
      harness.recordInputAudio(audio);
      sendAudioToSession(audio);
    };
    const closeSession = session.close.bind(session);
    let sessionClosePromise: Promise<void> | undefined;
    session.close = (): Promise<void> => {
      if (sessionClosed) {
        return sessionClosePromise ?? Promise.resolve();
      }
      sessionClosed = true;
      outboundGreeting.close();
      hostSpeech.close();
      activity.close();
      this.cancelConsultSession(callId, session, harness.forcedConsults);
      audioPacer.close();
      sessionClosePromise = drainProviderClose(closeSession).finally(() => {
        for (const key of [callId, callSid]) {
          if (this.activeBridgesByCallId.get(key) === session) {
            this.activeBridgesByCallId.delete(key);
          }
        }
        clearRecentFinalUserTranscript(userTranscriptOwner);
        harness.close();
      });
      return sessionClosePromise;
    };

    let bindingClosed = false;
    let bindingClosePromise: Promise<void> | undefined;
    const closeBinding = (cause?: RealtimeCallEndCause): Promise<void> => {
      if (bindingClosed) {
        return bindingClosePromise ?? callEndPromise ?? Promise.resolve();
      }
      bindingClosed = true;
      activity.close();
      const ownsCall = this.activeTelephonyBindingsByCallId.get(callId) === telephonyBinding;
      const finishClose = () => {
        const stillOwnsCall = this.activeTelephonyBindingsByCallId.get(callId) === telephonyBinding;
        if (stillOwnsCall) {
          this.activeTelephonyBindingsByCallId.delete(callId);
        }
        if (cause === "disconnect") {
          this.streamDisconnectLifecycle.disconnect(callSid, streamSid);
        } else {
          this.streamDisconnectLifecycle.retire(callSid, streamSid);
        }
        if (ownsCall && stillOwnsCall && cause && cause !== "disconnect") {
          return emitCallEnd(cause);
        }
        return Promise.resolve();
      };
      let pending: Promise<void>;
      try {
        pending = Promise.resolve(session.close());
      } catch (error) {
        pending = Promise.reject(
          error instanceof Error
            ? error
            : new Error("Realtime provider close failed", { cause: error }),
        );
      }
      bindingClosePromise = pending.then(finishClose, async (error: unknown) => {
        console.warn(
          `[voice-call] Failed to close realtime bridge ${callSid}: ${formatErrorMessage(error)}`,
        );
        try {
          await finishClose();
        } catch (terminationError) {
          throw new AggregateError([error, terminationError], "Realtime call cleanup failed", {
            cause: terminationError,
          });
        }
        throw error;
      });
      this.trackShutdownWork(bindingClosePromise, this.terminationAttempts);
      return bindingClosePromise;
    };
    const telephonyBinding: RealtimeTelephonyBinding = {
      bridge: session,
      acknowledgeCarrierMark: (markName) => {
        // Retire the played prefix before provider acknowledgement so any
        // truncation snapshot no longer carries carrier-confirmed items.
        audioPacer.acknowledgeMark(markName);
        if (!markName) {
          return;
        }
        const acknowledge = pendingMarkAcks.get(markName);
        if (acknowledge) {
          pendingMarkAcks.delete(markName);
          acknowledge();
        }
      },
      close: (cause) => closeBinding(cause),
      endCall: () => {
        // Close the provider session before the carrier socket so no pending
        // response can reach the caller after the hang-up request succeeds.
        void closeBinding();
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, "Call ended");
        }
      },
      noteMediaActivity: () => activity.noteMedia(),
      playVoicemail: (speechInstructions) => hostSpeech.speak(speechInstructions),
      retire: () => {
        void closeBinding();
      },
    };
    this.activeBridgesByCallId.set(callId, session);
    this.activeBridgesByCallId.set(callSid, session);
    this.activeTelephonyBindingsByCallId.set(callId, telephonyBinding);
    telephonyBinding.noteMediaActivity();
    activity.start();
    if (this.config.idleHangupMs) {
      console.log(
        `[voice-call] Realtime speech idle monitor armed callId=${callId} providerCallId=${callSid} timeoutMs=${this.config.idleHangupMs}`,
      );
    }
    if (previousTelephonyBinding && previousTelephonyBinding !== telephonyBinding) {
      previousTelephonyBinding.retire();
    }

    session.connect().catch(async (error: unknown) => {
      console.error("[voice-call] Failed to connect realtime bridge:", error);
      try {
        await closeBinding("error");
      } catch {
        // The binding reports cleanup failure and preserves it for concurrent shutdown.
      } finally {
        ws.close(1011, "Failed to connect");
      }
    });

    return telephonyBinding;
  }

  private cancelConsultSession(
    callId: string,
    owner: ActiveRealtimeVoiceBridge,
    coordinator: RealtimeVoiceSessionHarness["forcedConsults"],
    mode: "retire" | "continuity-reset" = "retire",
  ): void {
    coordinator.clearPending();
    const forced = this.forcedConsultsByCallId.get(callId);
    if (forced?.owner === owner) {
      forced.cancelled = true;
      forced.sendSpeechPrompt = false;
      forced.cancel();
      this.forcedConsultsByCallId.delete(callId);
    }
    const native = this.nativeConsultsInFlightByCallId.get(callId);
    if (native?.owner === owner) {
      this.nativeConsultsInFlightByCallId.delete(callId);
      native.cancel();
    }
    if (mode === "continuity-reset") {
      // A fresh provider session must not inherit cancelled/recent consult dedupe.
      coordinator.clear();
    }
  }

  private isActiveBridgeOwner(callId: string, owner: ActiveRealtimeVoiceBridge): boolean {
    return this.activeBridgesByCallId.get(callId) === owner;
  }

  private async waitForConsultTranscriptSettle(
    owner: UserTranscriptState,
    startedAt: number,
  ): Promise<void> {
    const deadline = startedAt + CONSULT_TRANSCRIPT_SETTLE_MAX_MS;
    while (true) {
      const updatedAt = owner.partial?.updatedAt;
      if (!updatedAt) {
        return;
      }
      const now = Date.now();
      const quietFor = now - updatedAt;
      if (quietFor >= CONSULT_TRANSCRIPT_SETTLE_MS || now >= deadline) {
        return;
      }
      await sleep(Math.min(CONSULT_TRANSCRIPT_SETTLE_MS - quietFor, deadline - now));
    }
  }

  private scheduleForcedAgentConsult(params: {
    harness: RealtimeVoiceSessionHarness;
    session: ActiveRealtimeVoiceBridge;
    callId: string;
    callSid: string;
    transcript: string;
    consultTranscript: TranscriptSnapshot | undefined;
    userTranscriptOwner: UserTranscriptState;
    clearAudio: () => void;
    beginConsultActivity: () => void;
    endConsultActivity: () => void;
  }): void {
    if (
      this.config.consultPolicy !== "always" ||
      this.activeBridgesByCallId.get(params.callId) !== params.session
    ) {
      return;
    }
    const question = params.transcript.trim();
    if (!question) {
      return;
    }
    const handler = this.toolHandlers.get(REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME);
    if (!handler) {
      return;
    }
    const existingForcedConsult = this.forcedConsultsByCallId.get(params.callId);
    if (existingForcedConsult && !existingForcedConsult.completedAt) {
      return;
    }
    const coordinator = params.harness.forcedConsults;
    if (coordinator.hasRecentNativeConsult(question, { allowUnknownQuestion: true })) {
      return;
    }
    coordinator.clearPending();
    const pending = coordinator.prepare(question);
    if (!pending) {
      return;
    }
    coordinator.schedule(pending, FORCED_CONSULT_FALLBACK_DELAY_MS, (handle) => {
      const activeForcedConsult = this.forcedConsultsByCallId.get(params.callId);
      if (activeForcedConsult && !activeForcedConsult.completedAt) {
        return;
      }
      void this.runForcedAgentConsult({
        ...params,
        handle,
        handler,
      });
    });
  }

  private async runForcedAgentConsult(params: {
    harness: RealtimeVoiceSessionHarness;
    session: ActiveRealtimeVoiceBridge;
    callId: string;
    callSid: string;
    handle: RealtimeVoiceForcedConsultHandle;
    consultTranscript: TranscriptSnapshot | undefined;
    userTranscriptOwner: UserTranscriptState;
    clearAudio: () => void;
    beginConsultActivity: () => void;
    endConsultActivity: () => void;
    handler: ToolHandlerFn;
  }): Promise<void> {
    const coordinator = params.harness.forcedConsults;
    coordinator.markStarted(params.handle);
    const startedAt = Date.now();
    logger.debug(
      `[voice-call] realtime forced agent consult reason=${FORCED_CONSULT_REASON} consultPolicy=always callId=${params.callId} providerCallId=${params.callSid} chars=${params.handle.question.length}`,
    );
    console.log(
      `[voice-call] realtime forced agent consult starting callId=${params.callId} providerCallId=${params.callSid} chars=${params.handle.question.length}`,
    );
    params.clearAudio();
    params.beginConsultActivity();
    const abortController = new AbortController();
    const state: ForcedConsultState = {
      owner: params.session,
      handle: params.handle,
      sendSpeechPrompt: true,
      cancelled: false,
      // Forced consult delivery and generation share one owner. Teardown must abort
      // the agent run as well as retire provider delivery, or superseded work leaks.
      cancel: () => {
        abortController.abort(new Error("Realtime forced consult owner was cancelled."));
        coordinator.markCancelled(params.handle);
      },
      promise: Promise.resolve().then(() => {
        abortController.signal.throwIfAborted();
        return params.handler(
          {
            question: params.handle.question,
          },
          params.callId,
          { abortSignal: abortController.signal },
        );
      }),
    };
    this.forcedConsultsByCallId.set(params.callId, state);
    try {
      const result = await state.promise;
      if (state.cancelled || this.forcedConsultsByCallId.get(params.callId) !== state) {
        return;
      }
      state.completedAt = Date.now();
      coordinator.markDelivered(params.handle);
      const text = readSpeakableRealtimeVoiceToolResult(result, {
        keys: ["text", "output"],
        maxChars: FORCED_CONSULT_RESULT_MAX_CHARS,
      });
      if (!text) {
        console.warn(
          `[voice-call] realtime forced agent consult returned no speakable text callId=${params.callId} providerCallId=${params.callSid}`,
        );
        return;
      }
      if (state.sendSpeechPrompt) {
        params.clearAudio();
        params.session.sendUserMessage(buildForcedConsultSpeechPrompt(text));
      }
      console.log(
        `[voice-call] realtime forced agent consult completed callId=${params.callId} providerCallId=${params.callSid} elapsedMs=${Date.now() - startedAt}`,
      );
      consumeUserTranscript(params.userTranscriptOwner, params.consultTranscript);
    } catch (error) {
      if (!state.cancelled) {
        const result = buildRealtimeVoiceAgentErrorProviderResult(error);
        const failed = "error" in result;
        const report = failed ? console.warn : console.log;
        report(
          `[voice-call] realtime forced agent consult ${failed ? "failed" : "cancelled"} callId=${params.callId} providerCallId=${params.callSid}${failed ? ` error=${result.error}` : ""}`,
        );
      }
    } finally {
      params.endConsultActivity();
      if (!state.cancelled) {
        if (this.forcedConsultsByCallId.get(params.callId) !== state) {
          coordinator.remove(params.handle);
        } else {
          const cleanupTimer = setTimeout(() => {
            if (this.forcedConsultsByCallId.get(params.callId) === state) {
              this.forcedConsultsByCallId.delete(params.callId);
              coordinator.remove(params.handle);
            }
          }, FORCED_CONSULT_NATIVE_DEDUPE_MS);
          cleanupTimer.unref?.();
        }
      }
    }
  }

  private async prepareCallInManager(
    callSid: string,
    callerMeta: Omit<PendingStreamToken, "expiry"> = {},
  ) {
    const timestamp = Date.now();
    const baseFields = {
      providerCallId: callSid,
      timestamp,
      direction: callerMeta.direction ?? "inbound",
      ...(callerMeta.from ? { from: callerMeta.from } : {}),
      ...(callerMeta.to ? { to: callerMeta.to } : {}),
    };

    let callRecord: CallRecord | undefined;
    if (callerMeta.callId) {
      const call = await this.manager.getCallForStream(callerMeta.callId);
      callRecord = call?.providerCallId === callSid ? call : undefined;
    } else {
      await this.manager.processEvent({
        id: `realtime-initiated-${callSid}`,
        callId: callSid,
        type: "call.initiated",
        ...baseFields,
      });
      callRecord = this.manager.getCallByProviderCallId(callSid);
    }
    return callRecord ? { callRecord, baseFields } : null;
  }

  private async executeEndCallTool(params: {
    bridge: ActiveRealtimeVoiceBridge;
    callId: string;
    bridgeCallId: string;
    turnId: string;
    harness: RealtimeVoiceSessionHarness;
  }): Promise<void> {
    const binding = this.activeTelephonyBindingsByCallId.get(params.callId);
    if (
      !binding ||
      binding.bridge !== params.bridge ||
      !this.isActiveBridgeOwner(params.callId, params.bridge)
    ) {
      return;
    }

    let result: { success: boolean; error?: string };
    try {
      result = await this.manager.endCall(params.callId);
    } catch (error) {
      result = { success: false, error: formatErrorMessage(error) };
    }

    if (
      this.activeTelephonyBindingsByCallId.get(params.callId) !== binding ||
      !this.isActiveBridgeOwner(params.callId, params.bridge)
    ) {
      return;
    }
    if (!result.success) {
      const detail = result.error?.trim() || "the telephony provider returned no reason";
      const toolResult = {
        error: `Could not end the current phone call: ${detail}. Tell the caller the call could not be ended and they can hang up or ask you to try again.`,
      };
      await params.bridge.submitToolResult(params.bridgeCallId, toolResult);
      params.harness.emit({
        type: "tool.error",
        turnId: params.turnId,
        callId: params.bridgeCallId,
        payload: { name: REALTIME_VOICE_END_CALL_TOOL_NAME, result: toolResult },
        final: true,
      });
      return;
    }

    params.harness.emit({
      type: "tool.result",
      turnId: params.turnId,
      callId: params.bridgeCallId,
      payload: { name: REALTIME_VOICE_END_CALL_TOOL_NAME, result: { success: true } },
      final: true,
    });
    binding.endCall();
  }

  private async executeToolCall(
    bridge: ActiveRealtimeVoiceBridge,
    callId: string,
    bridgeCallId: string,
    name: string,
    args: unknown,
    turnId: string,
    harness: RealtimeVoiceSessionHarness,
    userTranscriptOwner: UserTranscriptState,
    consultTranscript: NativeConsultTranscript | undefined,
    delegation?: { signal?: AbortSignal },
  ): Promise<unknown> {
    if (name === REALTIME_VOICE_END_CALL_TOOL_NAME) {
      await this.executeEndCallTool({ bridge, callId, bridgeCallId, turnId, harness });
      return undefined;
    }
    const handler = this.toolHandlers.get(name);
    const startedAt = Date.now();
    const hasResultError = (result: unknown): result is { error: unknown } => {
      return (
        result !== null && typeof result === "object" && !Array.isArray(result) && "error" in result
      );
    };
    const submitFinalToolResult = async (result: unknown): Promise<unknown> => {
      if (!delegation) {
        await bridge.submitToolResult(bridgeCallId, result);
      }
      harness.emit({
        type: hasResultError(result) ? "tool.error" : "tool.result",
        turnId,
        callId: bridgeCallId,
        payload: { name, result },
        final: true,
      });
      return result;
    };
    const invokeHandler = async (
      handlerArgs: unknown,
      context: ToolHandlerContext,
    ): Promise<unknown> => {
      console.log(
        `[voice-call] realtime tool call executing callId=${callId} tool=${name} hasHandler=${Boolean(handler)}`,
      );
      try {
        return handler
          ? await handler(handlerArgs, callId, context)
          : { error: `Tool "${name}" not available` };
      } catch (error) {
        return buildRealtimeVoiceAgentErrorProviderResult(error);
      }
    };
    const logResult = (result: unknown): boolean => {
      const failed = hasResultError(result);
      const error = failed ? formatErrorMessage(result.error ?? "unknown") : undefined;
      console.log(
        `[voice-call] realtime tool call completed callId=${callId} tool=${name} status=${failed ? "error" : "ok"} elapsedMs=${Date.now() - startedAt}${error ? ` error=${error}` : ""}`,
      );
      return failed;
    };
    const submitWorkingResponse = async (): Promise<void> => {
      if (
        !delegation &&
        handler &&
        name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME &&
        bridge.bridge.supportsToolResultContinuation &&
        !this.config.fastContext.enabled
      ) {
        await bridge.submitToolResult(
          bridgeCallId,
          buildRealtimeVoiceAgentConsultWorkingResponse("caller"),
          { willContinue: true },
        );
        harness.emit({
          type: "tool.progress",
          turnId,
          callId: bridgeCallId,
          payload: { name, status: "working" },
        });
      }
    };
    if (name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      if (this.activeBridgesByCallId.get(callId) !== bridge) {
        return undefined;
      }
      const submitBusyResult = () =>
        submitFinalToolResult({
          status: "busy",
          started: false,
          retryable: true,
          error:
            "OpenClaw is still consulting on a different request. This request has not started. Wait for that consult's result before you retry this request; do not poll while it is running.",
        });
      const coordinator = harness.forcedConsults;
      const forcedMatch = coordinator.recordNativeConsult(args, bridgeCallId);
      if (forcedMatch.kind === "none") {
        const pending = coordinator.consumePending();
        if (pending) {
          coordinator.remove(pending);
        }
      }
      const forcedConsultState = this.forcedConsultsByCallId.get(callId);
      const forcedConsult =
        forcedConsultState?.owner === bridge && !forcedConsultState.cancelled
          ? forcedConsultState
          : undefined;
      if (forcedMatch.kind === "already_delivered") {
        const cancelled = coordinator.isCancelled(forcedMatch.handle);
        if (cancelled && forcedConsult?.handle === forcedMatch.handle) {
          forcedConsult.sendSpeechPrompt = false;
        }
        return await submitFinalToolResult(
          cancelled
            ? {
                status: "cancelled",
                message: "OpenClaw cancelled this consult before completion. Do not restart it.",
              }
            : {
                status: "already_delivered",
                message:
                  "OpenClaw already delivered this consult result internally. Do not repeat it.",
              },
        );
      }
      if (
        forcedConsult &&
        forcedMatch.kind !== "none" &&
        forcedMatch.handle === forcedConsult.handle
      ) {
        forcedConsult.sendSpeechPrompt = false;
        const result = await forcedConsult.promise.catch(
          buildRealtimeVoiceAgentErrorProviderResult,
        );
        if (
          forcedConsult.cancelled ||
          forcedConsult.owner !== bridge ||
          this.forcedConsultsByCallId.get(callId) !== forcedConsult
        ) {
          return undefined;
        }
        return await submitFinalToolResult(result);
      }
      if (forcedConsult && !forcedConsult.completedAt) {
        return await submitBusyResult();
      }

      const existingNativeConsult = this.nativeConsultsInFlightByCallId.get(callId);
      if (existingNativeConsult?.owner === bridge && !existingNativeConsult.cancelled) {
        // Identical arguments can refer to newer speech. Only an exact invocation replay shares work.
        if (!bridgeCallId.trim() || existingNativeConsult.invocationId !== bridgeCallId) {
          return await submitBusyResult();
        }
        console.log(
          `[voice-call] realtime tool call sharing in-flight agent consult callId=${callId} ageMs=${Date.now() - existingNativeConsult.startedAt}`,
        );
        await submitWorkingResponse();
        const result = await existingNativeConsult.promise;
        if (existingNativeConsult.cancelled || !this.isActiveBridgeOwner(callId, bridge)) {
          return undefined;
        }
        return await submitFinalToolResult(result);
      }

      let transcript: TranscriptSnapshot | undefined;
      const abortController = new AbortController();
      const state: NativeConsultState = {
        owner: bridge,
        invocationId: bridgeCallId,
        startedAt,
        promise: (async () => {
          await submitWorkingResponse();
          await this.waitForConsultTranscriptSettle(userTranscriptOwner, startedAt);
          if (abortController.signal.aborted || !this.isActiveBridgeOwner(callId, bridge)) {
            return undefined;
          }
          transcript = consultTranscript?.();
          const context = {
            partialUserTranscript: transcript?.text,
            abortSignal: abortController.signal,
          };
          const handlerArgs = withFallbackConsultQuestion(args, context.partialUserTranscript);
          return await invokeHandler(handlerArgs, context);
        })().catch(buildRealtimeVoiceAgentErrorProviderResult),
        get cancelled() {
          return abortController.signal.aborted;
        },
        cancel: () => {
          abortController.abort(new Error("Realtime native consult owner was cancelled."));
        },
      };
      if (delegation?.signal?.aborted) {
        state.cancel();
      } else {
        delegation?.signal?.addEventListener("abort", state.cancel, { once: true });
      }
      this.nativeConsultsInFlightByCallId.set(callId, state);
      try {
        const result = await state.promise;
        if (state.cancelled || !this.isActiveBridgeOwner(callId, bridge)) {
          return undefined;
        }
        const failed = logResult(result);
        await submitFinalToolResult(result);
        if (!failed) {
          consumeUserTranscript(userTranscriptOwner, transcript);
        }
        return result;
      } finally {
        delegation?.signal?.removeEventListener("abort", state.cancel);
        if (this.nativeConsultsInFlightByCallId.get(callId) === state) {
          this.nativeConsultsInFlightByCallId.delete(callId);
        }
      }
    }
    const transcript = userTranscriptOwner;
    const result = await invokeHandler(args, {
      partialUserTranscript: (transcript.partial ?? transcript.recentFinal)?.text,
    });
    logResult(result);
    return await submitFinalToolResult(result);
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
