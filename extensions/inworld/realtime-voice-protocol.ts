import { randomUUID } from "node:crypto";
import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBargeInOptions,
  RealtimeVoicePlaybackItem,
  RealtimeVoiceSessionConnection,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  realtimeVoiceAudioDurationMs,
  toOpenAICompatibleRealtimeAudioFormat,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  INWORLD_REALTIME_DEFAULT_EAGERNESS,
  INWORLD_REALTIME_DEFAULT_PREFIX_PADDING_MS,
  INWORLD_REALTIME_DEFAULT_SILENCE_DURATION_MS,
  INWORLD_REALTIME_DEFAULT_STT_MODEL,
  INWORLD_REALTIME_DEFAULT_TTS_MODEL,
  INWORLD_REALTIME_DEFAULT_VAD_THRESHOLD,
  INWORLD_REALTIME_DEFAULT_VOICE,
  INWORLD_REALTIME_MAX_PENDING_PLAYBACK_MARKS,
  serializeInworldRealtimeToolResult,
  type InworldRealtimeEvent,
  type InworldRealtimeSessionUpdate,
  type InworldRealtimeVoiceBridgeConfig,
} from "./realtime-voice-config.js";
import {
  inworldAudioIdFingerprint,
  readInworldOutputFormat,
} from "./realtime-voice-truncate-diagnostics.js";

export class InworldRealtimePlaybackMarkOverflowError extends Error {}

type InworldAssistantAudioItem = {
  itemId: string;
  bytes: number;
  startTimestamp: number;
};

export abstract class InworldRealtimeVoiceProtocol {
  protected readonly audioFormat: RealtimeVoiceAudioFormat;
  protected markQueue: string[] = [];
  protected responseActive = false;
  protected responseCreateInFlight = false;
  protected responseCancelInFlight = false;
  protected responseCreatePending = false;
  protected pendingToolCallIds = new Set<string>();
  protected latestMediaTimestamp = 0;
  protected outputAudioGeneration = 0;
  private interruptingPlayback = false;
  protected assistantAudioItem: InworldAssistantAudioItem | null = null;
  private readonly producedAudioItems = new Map<
    string,
    { responseId?: string; itemId: string; bytes: number; generation: number }
  >();
  private audioResponseId: string | undefined;
  private negotiatedOutputFormat: ReturnType<typeof readInworldOutputFormat> = null;
  protected toolCallBuffers = new Map<string, { name: string; callId: string; args: string }>();
  protected deliveredToolCallKeys = new Set<string>();
  protected pendingToolResultAcks = new Set<string>();
  protected conversationId: string | null = null;

  constructor(protected readonly config: InworldRealtimeVoiceBridgeConfig) {
    this.audioFormat = config.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ;
  }

  protected abstract sendEvent(event: unknown, detail?: string): void;

  protected sendUserMessageNow(text: string): void {
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.requestResponseCreate();
  }

  protected submitToolResultNow(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    if (options?.willContinue === true) {
      return;
    }
    const output = serializeInworldRealtimeToolResult(result);
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output,
      },
    });
    this.pendingToolResultAcks.add(callId);
    this.pendingToolCallIds.delete(callId);
    if (options?.suppressResponse !== true) {
      this.requestResponseCreate();
    }
  }

  acknowledgeMark(markName?: string): void {
    if (this.markQueue.length === 0) {
      return;
    }
    if (markName) {
      const index = this.markQueue.indexOf(markName);
      if (index < 0) {
        return;
      }
      this.markQueue.splice(index, 1);
    } else {
      this.markQueue.shift();
    }
    if (this.markQueue.length === 0) {
      this.flushPendingResponseCreate();
    }
  }

  handleBargeIn(options?: RealtimeVoiceBargeInOptions): void {
    this.interruptPlayback("barge-in", options);
  }

  protected handleServerVadBargeIn(): void {
    this.interruptPlayback("server-vad-barge-in");
  }

  private audioEndMs(item: InworldAssistantAudioItem): number {
    const producedAudioMs = Math.floor(realtimeVoiceAudioDurationMs(this.audioFormat, item.bytes));
    const playbackAudioMs = Math.max(0, this.latestMediaTimestamp - item.startTimestamp);
    return Math.min(producedAudioMs, playbackAudioMs);
  }

  private inworldTruncateMs(realAudioMs: number): number {
    // Live PCMU errors report duration as bytes/24, despite mono 8 kHz output.
    // Inworld's truncate timebase is 24 kHz: convert real ms after the byte clamp.
    // PCM16 retains its ordinary millisecond contract.
    return this.audioFormat.encoding === "g711_ulaw" && this.audioFormat.sampleRateHz === 8000
      ? Math.floor(realAudioMs / 3)
      : realAudioMs;
  }

  protected beginAudioResponse(responseId: string | undefined): void {
    this.audioResponseId = responseId;
    // Preserve distinct completed items still queued in the sink, but a new
    // incarnation of this response must not inherit its previous byte counters.
    for (const [key, item] of this.producedAudioItems) {
      if (item.responseId === responseId || !this.config.getPlaybackState) {
        this.producedAudioItems.delete(key);
      }
    }
  }

  protected beginAssistantAudioItem(itemId: string, responseId = this.audioResponseId): void {
    for (const [key, item] of this.producedAudioItems) {
      if (item.itemId === itemId) {
        this.producedAudioItems.delete(key);
      }
    }
    this.producedAudioItems.set(this.audioItemKey(itemId, responseId), {
      responseId,
      itemId,
      bytes: 0,
      generation: this.outputAudioGeneration,
    });
    // An added distinct item has no audio yet; the legacy sink may still play
    // its predecessor. Reused IDs must drop their old timestamp before callbacks.
    if (this.assistantAudioItem?.itemId === itemId) {
      this.assistantAudioItem = null;
    }
  }

  protected recordNegotiatedOutputFormat(value: unknown): void {
    if (value !== undefined) {
      this.negotiatedOutputFormat = readInworldOutputFormat(value);
    }
  }

  private audioItemKey(itemId: string, responseId: string | undefined): string {
    return JSON.stringify([
      responseId ?? null,
      responseId ? null : this.outputAudioGeneration,
      itemId,
    ]);
  }

  protected recordAssistantAudio(
    itemId: string | undefined,
    bytes: number,
    responseId = this.audioResponseId,
  ): void {
    if (itemId) {
      const key = this.audioItemKey(itemId, responseId);
      const previous = this.producedAudioItems.get(key);
      if (previous?.generation !== this.outputAudioGeneration) {
        // Keep completed items only while the sink still has their playback. A
        // reused ID in a successor response starts a new provider audio bound.
        const pendingIds = new Set(this.config.getPlaybackState?.().map((item) => item.itemId));
        for (const [id, item] of this.producedAudioItems) {
          if (!pendingIds.has(item.itemId) || item.itemId === itemId) {
            this.producedAudioItems.delete(id);
          }
        }
      }
      this.producedAudioItems.set(key, {
        responseId,
        itemId,
        bytes: (previous?.generation === this.outputAudioGeneration ? previous.bytes : 0) + bytes,
        generation: this.outputAudioGeneration,
      });
    }
    if (itemId && itemId !== this.assistantAudioItem?.itemId) {
      this.assistantAudioItem = { itemId, bytes, startTimestamp: this.latestMediaTimestamp };
    } else if (this.assistantAudioItem) {
      this.assistantAudioItem.bytes += bytes;
    }
  }

  private interruptPlayback(
    reason: "barge-in" | "server-vad-barge-in",
    options?: RealtimeVoiceBargeInOptions,
  ): void {
    // Wire observers can synchronously reenter before the sink clears its snapshot.
    if (this.interruptingPlayback) {
      return;
    }
    this.interruptingPlayback = true;
    try {
      const item = this.assistantAudioItem;
      const hasLegacyPlayback =
        this.markQueue.length > 0 ||
        (reason === "barge-in" && (this.responseActive || options?.audioPlaybackActive === true));
      // Timestamp/mark-only transports retain their shipped clock contract;
      // an empty native snapshot means all prior audio was already heard.
      const playbackState: readonly RealtimeVoicePlaybackItem[] = this.config.getPlaybackState
        ? this.config.getPlaybackState()
        : item && hasLegacyPlayback
          ? [{ itemId: item.itemId, audioEndMs: this.audioEndMs(item) }]
          : [];
      const playbackItems = playbackState.map(({ itemId, audioEndMs }) => {
        const produced = Array.from(this.producedAudioItems.values()).findLast(
          (candidate) => candidate.itemId === itemId,
        );
        return {
          itemId,
          responseId: produced?.responseId,
          countedBytes: produced?.bytes ?? 0,
          audioEndMs: this.inworldTruncateMs(
            this.config.getPlaybackState
              ? Math.max(
                  0,
                  Math.min(
                    Number.isFinite(audioEndMs) ? Math.floor(audioEndMs) : 0,
                    Math.floor(
                      realtimeVoiceAudioDurationMs(this.audioFormat, produced?.bytes ?? 0),
                    ),
                  ),
                )
              : audioEndMs,
          ),
        };
      });
      const cancelResponse =
        reason === "barge-in" &&
        (this.responseActive || this.responseCreateInFlight || playbackItems.length > 0) &&
        !this.responseCancelInFlight;
      this.outputAudioGeneration += 1;
      this.markQueue = [];
      this.assistantAudioItem = null;
      this.producedAudioItems.clear();
      if (this.responseActive || this.responseCreateInFlight) {
        this.responseCancelInFlight = true;
      }
      // Cancel before truncating playback, as on the OpenAI-compatible flow.
      // Only active generation has a later response.done; VAD owns its cancellation.
      if (cancelResponse) {
        this.sendEvent({ type: "response.cancel" }, `reason=${reason}`);
      }
      for (const playbackItem of playbackItems) {
        console.info(
          `[inworld] truncate ${JSON.stringify({
            response_id: inworldAudioIdFingerprint(playbackItem.responseId),
            item_id: inworldAudioIdFingerprint(playbackItem.itemId),
            counted_bytes: playbackItem.countedBytes,
            audio_end_ms: playbackItem.audioEndMs,
            audioFormat: {
              encoding: this.audioFormat.encoding,
              sampleRateHz: this.audioFormat.sampleRateHz,
              channels: this.audioFormat.channels,
            },
            negotiated_output_format: this.negotiatedOutputFormat,
          })}`,
        );
        this.sendEvent(
          {
            type: "conversation.item.truncate",
            item_id: playbackItem.itemId,
            content_index: 0,
            audio_end_ms: playbackItem.audioEndMs,
          },
          `reason=${reason} audioEndMs=${playbackItem.audioEndMs}`,
        );
      }
      // The sink can request replacement generation when cleared; trim its history first.
      this.config.onClearAudio("barge-in");
    } finally {
      this.interruptingPlayback = false;
    }
    // Observer requests wait until history and the sink are cleared. Server VAD
    // owns its next response; only a host interruption drains this gate.
    if (reason === "barge-in") {
      this.flushPendingResponseCreate();
    }
  }

  protected buildSessionUpdate(): InworldRealtimeSessionUpdate {
    const cfg = this.config;
    const format = toOpenAICompatibleRealtimeAudioFormat(this.audioFormat);
    const turnDetection: InworldRealtimeSessionUpdate["session"]["audio"]["input"]["turn_detection"] =
      cfg.turnDetection === "server_vad"
        ? {
            type: "server_vad",
            threshold: cfg.vadThreshold ?? INWORLD_REALTIME_DEFAULT_VAD_THRESHOLD,
            prefix_padding_ms: cfg.prefixPaddingMs ?? INWORLD_REALTIME_DEFAULT_PREFIX_PADDING_MS,
            silence_duration_ms:
              cfg.silenceDurationMs ?? INWORLD_REALTIME_DEFAULT_SILENCE_DURATION_MS,
            create_response: true,
            interrupt_response: true,
          }
        : {
            type: "semantic_vad",
            eagerness: cfg.eagerness ?? INWORLD_REALTIME_DEFAULT_EAGERNESS,
            create_response: true,
            interrupt_response: true,
          };
    const passthrough = cfg.providerData ?? {};
    const section = (name: keyof typeof passthrough) => passthrough[name] ?? {};
    // Typed settings win over the documented passthrough; the passthrough can add
    // documented fields but never replace a typed one.
    const tts = {
      ...section("tts"),
      ...(cfg.deliveryMode ? { delivery_mode: cfg.deliveryMode } : {}),
      ...(cfg.steeringHandling ? { steering_handling: cfg.steeringHandling } : {}),
      ...(cfg.segmenterStrategy ? { segmenter_strategy: cfg.segmenterStrategy } : {}),
    };
    const responsiveness = {
      ...section("responsiveness"),
      ...(cfg.responsiveness === undefined ? {} : { enabled: cfg.responsiveness }),
    };
    const stt = section("stt");
    const memory = section("memory");
    const providerData: InworldRealtimeSessionUpdate["session"]["providerData"] = {
      ...(Object.keys(stt).length > 0 ? { stt } : {}),
      ...(Object.keys(tts).length > 0 ? { tts } : {}),
      ...(Object.keys(memory).length > 0 ? { memory } : {}),
      ...(Object.keys(responsiveness).length > 0 ? { responsiveness } : {}),
      // Pinned last: the host owns response.create after tool outputs (OpenAI-compatible
      // flow), and no passthrough section can reach this key.
      auto_tool_response: false,
    };
    return {
      type: "session.update",
      session: {
        type: "realtime",
        ...(cfg.model ? { model: cfg.model } : {}),
        ...(cfg.instructions ? { instructions: cfg.instructions } : {}),
        output_modalities: ["audio"],
        ...(cfg.temperature === undefined ? {} : { temperature: cfg.temperature }),
        audio: {
          input: {
            format,
            transcription: {
              model: cfg.sttModel ?? INWORLD_REALTIME_DEFAULT_STT_MODEL,
              ...(cfg.language ? { language: cfg.language } : {}),
            },
            turn_detection: turnDetection,
          },
          output: {
            format,
            voice: cfg.voice ?? INWORLD_REALTIME_DEFAULT_VOICE,
            model: cfg.ttsModel ?? INWORLD_REALTIME_DEFAULT_TTS_MODEL,
            ...(cfg.speakingRate === undefined ? {} : { speed: cfg.speakingRate }),
          },
        },
        providerData,
        ...(cfg.tools?.length
          ? {
              tools: cfg.tools,
              tool_choice: "auto",
            }
          : {}),
      },
    };
  }

  protected emitToolCallOnce(fields: {
    itemId?: string;
    callId?: string;
    name?: string;
    rawArgs?: string;
  }): void {
    if (!this.config.onToolCall) {
      return;
    }
    const itemId = fields.itemId || fields.callId || "unknown";
    const callId = fields.callId || itemId;
    const name = fields.name || "";
    const dedupeKey = fields.itemId || fields.callId || `${name}:${fields.rawArgs ?? ""}`;
    if (this.deliveredToolCallKeys.has(dedupeKey)) {
      return;
    }
    let args: unknown;
    try {
      args = JSON.parse(fields.rawArgs || "{}");
    } catch {
      this.rejectToolCallArguments({
        itemId,
        callId,
        dedupeKey,
        reason: "malformed-json",
      });
      return;
    }
    if (!isRecord(args)) {
      this.rejectToolCallArguments({
        itemId,
        callId,
        dedupeKey,
        reason: "non-object-json",
      });
      return;
    }
    this.deliveredToolCallKeys.add(dedupeKey);
    this.pendingToolCallIds.add(callId);
    this.config.onToolCall({ itemId, callId, name, args });
  }

  private rejectToolCallArguments(params: {
    itemId: string;
    callId: string;
    dedupeKey: string;
    reason: string;
  }): void {
    // Treat argument rejection as terminal and dedupe it before sending so a retry
    // cannot complete the call twice.
    this.deliveredToolCallKeys.add(params.dedupeKey);
    this.config.onEvent?.({
      direction: "server",
      type: "tool_call.arguments.rejected",
      detail: `reason=${params.reason}`,
      itemId: params.itemId,
    });
    this.submitToolResultNow(params.callId, { error: "Invalid tool arguments." });
  }

  protected requestResponseCreate(): void {
    // With auto_tool_response disabled every function output precedes one response.create,
    // and relay playback must drain before the next response starts.
    if (
      this.interruptingPlayback ||
      this.responseActive ||
      this.responseCreateInFlight ||
      this.responseCancelInFlight ||
      this.markQueue.length > 0 ||
      this.pendingToolCallIds.size > 0
    ) {
      this.responseCreatePending = true;
      return;
    }
    this.responseCreatePending = false;
    this.responseCreateInFlight = true;
    this.sendEvent({ type: "response.create" });
  }

  protected flushPendingResponseCreate(): void {
    if (!this.responseCreatePending) {
      return;
    }
    this.responseCreatePending = false;
    this.requestResponseCreate();
  }

  protected resetRealtimeSessionState(options: { preserveToolCallState?: boolean } = {}): void {
    this.outputAudioGeneration += 1;
    this.markQueue = [];
    this.responseActive = false;
    this.responseCreateInFlight = false;
    this.responseCancelInFlight = false;
    this.responseCreatePending = false;
    this.assistantAudioItem = null;
    this.producedAudioItems.clear();
    this.audioResponseId = undefined;
    this.negotiatedOutputFormat = null;
    this.resetInputTranscripts();
    if (!options.preserveToolCallState) {
      this.pendingToolCallIds.clear();
      this.toolCallBuffers.clear();
      this.deliveredToolCallKeys.clear();
      this.pendingToolResultAcks.clear();
    }
  }

  protected createPlaybackMark(): string {
    // Playback marks gate the next response. Dropping one would invent an
    // acknowledgement, so fail before delivering audio that cannot be tracked.
    if (this.markQueue.length >= INWORLD_REALTIME_MAX_PENDING_PLAYBACK_MARKS) {
      throw new InworldRealtimePlaybackMarkOverflowError(
        `Inworld realtime voice playback mark limit exceeded (${INWORLD_REALTIME_MAX_PENDING_PLAYBACK_MARKS})`,
      );
    }
    const markName = `audio-${randomUUID()}`;
    this.markQueue.push(markName);
    return markName;
  }

  protected abstract resetInputTranscripts(): void;
  protected abstract handleEvent(
    event: InworldRealtimeEvent,
    connection: RealtimeVoiceSessionConnection,
  ): void;
}
