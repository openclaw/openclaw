import {
  canonicalizeBase64,
  normalizeRealtimeVoiceResponseOutcome,
  type RealtimeVoiceSessionConnection,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import {
  asOptionalObjectRecord,
  isRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  readInworldRealtimeErrorDetail,
  type InworldRealtimeEvent,
} from "./realtime-voice-config.js";
import { InworldRealtimeVoiceProtocol } from "./realtime-voice-protocol.js";

export class InworldRealtimeMalformedAudioError extends Error {}

// Quiet period before committing input that was recognized after its response settled.
const INWORLD_REALTIME_INPUT_SETTLE_MS = 1_500;

export abstract class InworldRealtimeVoiceEvents extends InworldRealtimeVoiceProtocol {
  private assistantTranscriptBuffer = "";
  private assistantTranscriptFinalized = false;
  private pendingInputTranscript: { key: string; text: string } | undefined;
  private finalizedInputTranscriptKeys = new Set<string>();
  private inputSpeechSequence = 0;
  private inputResponseStarted = false;
  private inputResponseFinished = false;
  private outputResponse: { id?: string; ended: boolean } | undefined;
  private finalizedToolCallItems = new Set<string>();
  private inputTranscriptReplacements = new Map<string, string>();
  private inputSettleTimer: ReturnType<typeof setTimeout> | undefined;

  protected abstract acceptsEvent(connection: RealtimeVoiceSessionConnection): boolean;
  protected abstract onSessionUpdated(connection: RealtimeVoiceSessionConnection): void;

  protected handleEvent(
    event: InworldRealtimeEvent,
    connection: RealtimeVoiceSessionConnection,
  ): void {
    const responseId = event.response_id ?? event.response?.id;
    // A terminal retires all output from that response. Fence late deltas and
    // duplicate terminals before they reach the relay or mutate the next response.
    // Back-channel events are out-of-band from the main response and carry no response
    // id; keep them out of the fence so they reach the tolerant diagnostics branch.
    const isBackchannelEvent = event.type.startsWith("response.backchannel.");
    if (
      event.type.startsWith("response.") &&
      !isBackchannelEvent &&
      event.type !== "response.created" &&
      this.outputResponse &&
      (this.outputResponse.ended ||
        (responseId && this.outputResponse.id && responseId !== this.outputResponse.id))
    ) {
      return;
    }
    if (event.type === "response.created" && this.acceptsEvent(connection)) {
      // Publish the response owner before observers can interrupt its first PCM.
      this.inputResponseStarted = true;
      this.inputResponseFinished = false;
      // Cancellation before response.created belongs to that pending response.
      // Only an identified successor can retire an older live response's fence.
      if (
        this.outputResponse &&
        !this.outputResponse.ended &&
        responseId &&
        this.outputResponse.id &&
        responseId !== this.outputResponse.id
      ) {
        this.responseCancelInFlight = false;
      }
      this.outputResponse = { id: responseId, ended: false };
      // The fence drops a retired response's late terminal, including its buffer
      // cleanup, so the successor must not inherit the predecessor's tool calls.
      this.toolCallBuffers.clear();
      this.finalizedToolCallItems.clear();
      this.outputAudioGeneration += 1;
      this.beginAudioResponse(responseId);
      this.responseActive = true;
      this.responseCreateInFlight = false;
      this.markQueue = [];
      this.assistantAudioItem = null;
      this.resetAssistantTranscript();
    }
    if (event.type === "response.output_item.added" && this.acceptsEvent(connection)) {
      // Publish the fresh item bound before a wire observer can barge in.
      const itemId = event.item?.id ?? event.item_id;
      if (itemId && (!event.item?.type || event.item.type === "message")) {
        this.beginAssistantAudioItem(itemId, responseId);
      }
    }
    const audioGeneration = this.outputAudioGeneration;
    if (
      (event.type === "session.created" || event.type === "session.updated") &&
      this.acceptsEvent(connection)
    ) {
      this.recordNegotiatedOutputFormat(
        event.session?.audio?.output?.format ?? event.session?.output_audio_format,
      );
    }
    const bridgeEvent = {
      direction: "server",
      type: event.type,
      detail: this.describeServerEvent(event),
      ...(event.item_id ? { itemId: event.item_id } : {}),
      ...((event.response_id ?? event.response?.id)
        ? { responseId: event.response_id ?? event.response?.id }
        : {}),
    } as const;
    const emitBridgeEvent = () => this.config.onEvent?.(bridgeEvent);
    if (event.type !== "response.done" || !this.acceptsEvent(connection)) {
      emitBridgeEvent();
    }
    if (!this.acceptsEvent(connection)) {
      return;
    }
    switch (event.type) {
      case "session.created":
      // The adapter never enables back-channel, so these should not arrive. If a
      // deployment sends them anyway they are tolerated as diagnostics only: the host
      // playback contract has no out-of-band channel (Talk output needs a live response
      // owner; Voice Call truncates every snapshot item), so no audio is delivered.
      case "response.backchannel.audio.delta":
      case "response.backchannel.audio.done":
      case "response.backchannel.skipped":
        return;
      case "conversation.created": {
        const conversationId = normalizeOptionalString(event.conversation?.id);
        if (conversationId) {
          this.conversationId = conversationId;
        }
        return;
      }
      case "conversation.item.created":
      case "conversation.item.added": {
        const item = event.item;
        const callId = normalizeOptionalString(item?.call_id);
        if (item?.type === "function_call_output" && callId) {
          this.pendingToolResultAcks.delete(callId);
          return;
        }
        if (event.type === "conversation.item.created") {
          // Completed items created by the server are authoritative; deliver them once.
          this.emitCompletedToolCall(item, event);
        }
        return;
      }
      case "session.updated":
        this.onSessionUpdated(connection);
        return;
      case "response.output_audio.delta": {
        const audioDelta = event.delta ?? event.data;
        if (
          !audioDelta ||
          this.responseCancelInFlight ||
          audioGeneration !== this.outputAudioGeneration
        ) {
          return;
        }
        const canonicalAudio = canonicalizeBase64(audioDelta);
        if (!canonicalAudio) {
          throw new InworldRealtimeMalformedAudioError(
            "Inworld realtime voice stream returned malformed base64 audio data",
          );
        }
        const audio = Buffer.from(canonicalAudio, "base64");
        this.recordAssistantAudio(event.item_id, audio.byteLength, responseId);
        this.responseActive = true;
        const markName = this.createPlaybackMark();
        this.config.onAudio(audio, event.item_id ? { itemId: event.item_id } : undefined);
        if (audioGeneration === this.outputAudioGeneration && this.acceptsEvent(connection)) {
          this.config.onMark?.(markName, () => {
            if (this.acceptsEvent(connection)) {
              this.acknowledgeMark(markName);
            }
          });
        }
        return;
      }
      case "input_audio_buffer.speech_started":
        this.flushPendingInputTranscript();
        this.inputSpeechSequence += 1;
        this.inputResponseStarted = false;
        this.inputResponseFinished = false;
        this.handleServerVadBargeIn();
        return;
      case "response.text.delta":
      case "response.output_text.delta":
      case "response.output_audio_transcript.delta":
        if (event.delta) {
          this.appendAssistantTranscriptDelta(event.delta);
        }
        return;
      case "response.text.done":
      case "response.output_text.done":
      case "response.output_audio_transcript.done":
        if (this.isCurrentInputResponse(event)) {
          this.flushPendingInputTranscript();
          if (!this.acceptsEvent(connection)) {
            return;
          }
        }
        this.flushAssistantTranscript(event.transcript ?? event.text);
        return;
      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.config.onTranscript?.("user", event.delta, false);
        }
        return;
      case "conversation.item.input_audio_transcription.updated":
        if (event.transcript) {
          this.inputTranscriptReplacements.set(this.inputTranscriptKey(event), event.transcript);
        }
        return;
      case "conversation.item.input_audio_transcription.completed": {
        const key = this.inputTranscriptKey(event);
        const transcript = event.transcript ?? this.inputTranscriptReplacements.get(key);
        this.inputTranscriptReplacements.delete(key);
        if (!transcript || this.finalizedInputTranscriptKeys.has(key)) {
          return;
        }
        if (this.pendingInputTranscript && this.pendingInputTranscript.key !== key) {
          this.flushPendingInputTranscript();
          if (!this.acceptsEvent(connection)) {
            return;
          }
        }
        this.pendingInputTranscript = { key, text: transcript };
        // Completed events may be cumulative snapshots rather than utterance boundaries.
        // Preview immediately; commit once the response settles, so later corrections
        // cannot either duplicate the user message or truncate it permanently.
        this.config.onTranscript?.("user", transcript, false, { textMode: "snapshot" });
        if (this.inputResponseFinished) {
          // Recognition landed after the response settled; the server may still revise
          // this item, so commit it after a quiet period rather than at once.
          this.armInputSettleTimer();
        }
        return;
      }
      case "conversation.item.input_audio_transcription.failed": {
        const key = this.inputTranscriptKey(event);
        if (this.pendingInputTranscript?.key === key) {
          this.pendingInputTranscript = undefined;
        }
        this.inputTranscriptReplacements.delete(key);
        this.config.onError?.(new Error(readInworldRealtimeErrorDetail(event.error)));
        return;
      }
      case "response.done": {
        // A trailing terminal from an interrupted response must not settle new speech.
        if (this.isCurrentInputResponse(event)) {
          this.inputResponseFinished = true;
          this.flushPendingInputTranscript();
          if (!this.acceptsEvent(connection)) {
            return;
          }
        }
        const output = Array.isArray(event.response?.output)
          ? event.response.output.filter(isRecord)
          : [];
        const outcome = normalizeRealtimeVoiceResponseOutcome({
          providerLabel: "Inworld realtime voice",
          response: event.response,
          responseId: event.response_id,
        });
        // Non-completed responses discard their output. Retire those marks without
        // claiming playback so they cannot block the next response indefinitely.
        if (outcome.status !== "completed") {
          this.markQueue = [];
          this.assistantAudioItem = null;
        }
        let callbackError: unknown;
        const invoke = (callback: () => void) => {
          try {
            callback();
          } catch (error) {
            callbackError ??= error;
          }
        };
        try {
          // Deliver output before completion retires its response owner. Tool callbacks
          // may close the connection, so remaining output must recheck that owner.
          invoke(() => {
            if (outcome.status === "completed") {
              for (const [itemId, toolCall] of this.toolCallBuffers) {
                if (!this.acceptsEvent(connection)) {
                  return;
                }
                this.emitToolCallOnce({
                  itemId,
                  callId: toolCall.callId,
                  name: toolCall.name,
                  rawArgs: toolCall.args,
                });
              }
              for (const item of output) {
                if (!this.acceptsEvent(connection)) {
                  return;
                }
                this.emitCompletedToolCall(item, event);
              }
            }
            if (!this.acceptsEvent(connection)) {
              return;
            }
            const terminalTranscript = output
              .filter((item) => item.type === "message" && item.role === "assistant")
              .flatMap((item) => (Array.isArray(item.content) ? item.content.filter(isRecord) : []))
              .map((content) =>
                typeof content.transcript === "string"
                  ? content.transcript
                  : typeof content.text === "string"
                    ? content.text
                    : "",
              )
              .join("");
            this.flushAssistantTranscript(terminalTranscript);
          });
          if (this.outputResponse) {
            this.outputResponse.ended = true;
          }
          invoke(() => this.config.onResponseDone?.(outcome));
          invoke(emitBridgeEvent);
        } finally {
          // Keep the response active through terminal tool discovery: callbacks can
          // submit results synchronously and must not start the next response early.
          this.responseActive = false;
          this.responseCreateInFlight = false;
          this.responseCancelInFlight = false;
          this.toolCallBuffers.clear();
          this.finalizedToolCallItems.clear();
          this.flushPendingResponseCreate();
        }
        if (callbackError) {
          throw callbackError instanceof Error
            ? callbackError
            : new Error("Inworld realtime response callback failed", { cause: callbackError });
        }
        return;
      }
      case "response.function_call_arguments.delta": {
        const key = event.item_id ?? "unknown";
        const existing = this.toolCallBuffers.get(key);
        if (existing && event.delta) {
          existing.args += event.delta;
        } else if (event.item_id) {
          this.toolCallBuffers.set(event.item_id, {
            name: event.name ?? "",
            callId: event.call_id ?? "",
            args: event.delta ?? "",
          });
        }
        return;
      }
      case "response.function_call_arguments.done": {
        const key = event.item_id ?? "unknown";
        if (this.finalizedToolCallItems.has(key)) {
          return;
        }
        const buffered = this.toolCallBuffers.get(key);
        // Keep finalized arguments for diagnostics only. response.done with a completed
        // response is the authoritative execution boundary for provider tool calls.
        if (event.item_id) {
          this.finalizedToolCallItems.add(event.item_id);
          this.toolCallBuffers.set(event.item_id, {
            name: buffered?.name || event.name || "",
            callId: buffered?.callId || event.call_id || "",
            args: event.arguments ?? buffered?.args ?? "",
          });
        }
        return;
      }
      case "response.output_item.done":
        this.bufferCompletedToolCall(event.item, event);
        return;
      case "error":
        this.handleErrorEvent(event.error);
      default:
    }
  }

  protected resetInputTranscripts(): void {
    this.flushPendingInputTranscript();
    this.inputTranscriptReplacements.clear();
    this.finalizedInputTranscriptKeys.clear();
    this.inputResponseStarted = false;
    this.inputResponseFinished = false;
    this.outputResponse = undefined;
    this.finalizedToolCallItems.clear();
  }

  private isCurrentInputResponse(event: InworldRealtimeEvent): boolean {
    const responseId = event.response_id ?? event.response?.id;
    return (
      this.inputResponseStarted &&
      (!responseId || !this.outputResponse?.id || responseId === this.outputResponse.id)
    );
  }

  private armInputSettleTimer(): void {
    clearTimeout(this.inputSettleTimer);
    this.inputSettleTimer = setTimeout(() => {
      this.inputSettleTimer = undefined;
      this.flushPendingInputTranscript();
    }, INWORLD_REALTIME_INPUT_SETTLE_MS);
    this.inputSettleTimer.unref?.();
  }

  private flushPendingInputTranscript(): void {
    clearTimeout(this.inputSettleTimer);
    this.inputSettleTimer = undefined;
    const pending = this.pendingInputTranscript;
    this.pendingInputTranscript = undefined;
    if (!pending) {
      return;
    }
    this.finalizedInputTranscriptKeys.add(pending.key);
    if (this.finalizedInputTranscriptKeys.size > 1_024) {
      const oldest = this.finalizedInputTranscriptKeys.values().next().value;
      if (oldest !== undefined) {
        this.finalizedInputTranscriptKeys.delete(oldest);
      }
    }
    this.config.onTranscript?.("user", pending.text, true, { textMode: "snapshot" });
  }

  private emitCompletedToolCall(
    item: InworldRealtimeEvent["item"],
    event: InworldRealtimeEvent,
  ): void {
    if (item?.type === "function_call" && (!item.status || item.status === "completed")) {
      // Completed items and resumed replay are authoritative; added items can
      // still be in progress and must not dispatch incomplete arguments.
      this.emitToolCallOnce({
        itemId: item.id ?? event.item_id,
        callId: item.call_id,
        name: item.name,
        rawArgs: item.arguments,
      });
    }
  }

  private bufferCompletedToolCall(
    item: InworldRealtimeEvent["item"],
    event: InworldRealtimeEvent,
  ): void {
    if (item?.type !== "function_call" || (item.status && item.status !== "completed")) {
      return;
    }
    const itemId = item.id ?? event.item_id;
    if (!itemId) {
      return;
    }
    this.toolCallBuffers.set(itemId, {
      name: item.name ?? "",
      callId: item.call_id ?? "",
      args: item.arguments ?? "",
    });
  }

  private appendAssistantTranscriptDelta(delta: string): void {
    if (this.assistantTranscriptFinalized) {
      this.assistantTranscriptBuffer = "";
      this.assistantTranscriptFinalized = false;
    }
    this.assistantTranscriptBuffer += delta;
    this.config.onTranscript?.("assistant", delta, false);
  }

  private flushAssistantTranscript(finalTranscript?: string): void {
    if (this.assistantTranscriptFinalized) {
      return;
    }
    const transcript = finalTranscript || this.assistantTranscriptBuffer;
    if (transcript) {
      this.config.onTranscript?.("assistant", transcript, true);
      this.assistantTranscriptFinalized = true;
    }
    this.assistantTranscriptBuffer = "";
  }

  private resetAssistantTranscript(): void {
    this.assistantTranscriptBuffer = "";
    this.assistantTranscriptFinalized = false;
  }

  private inputTranscriptKey(event: InworldRealtimeEvent): string {
    return event.item_id ?? event.response_id ?? `speech-${this.inputSpeechSequence}`;
  }

  private handleErrorEvent(error: unknown): void {
    const detail = readInworldRealtimeErrorDetail(error);
    const code = normalizeOptionalString(asOptionalObjectRecord(error)?.code);
    // A late error for an older response.cancel must not retire a successor
    // response; only an in-flight cancellation may settle it.
    if (code === "response_cancel_not_active" || /no active response/i.test(detail)) {
      if (!this.responseCancelInFlight) {
        return;
      }
      this.responseActive = false;
      this.responseCancelInFlight = false;
      this.flushPendingResponseCreate();
      return;
    }
    if (/active response/i.test(detail)) {
      this.responseActive = true;
      this.responseCreateInFlight = false;
      this.responseCreatePending = true;
      return;
    }
    this.config.onError?.(new Error(detail));
  }

  private describeServerEvent(event: InworldRealtimeEvent): string | undefined {
    if (event.type.startsWith("response.backchannel.")) {
      return (
        [
          event.backchannel_id ? `backchannelId=${event.backchannel_id}` : undefined,
          event.phrase ? `phrase=${JSON.stringify(event.phrase)}` : undefined,
          event.reason ? `reason=${event.reason}` : undefined,
        ]
          .filter(Boolean)
          .join(" ") || undefined
      );
    }
    if (
      event.type === "error" ||
      event.type === "conversation.item.input_audio_transcription.failed"
    ) {
      return readInworldRealtimeErrorDetail(event.error);
    }
    if (event.type !== "response.done") {
      return undefined;
    }
    const status = event.response?.status;
    const details =
      event.response?.status_details === undefined
        ? undefined
        : JSON.stringify(event.response.status_details);
    return (
      [status ? `status=${status}` : undefined, details].filter(Boolean).join(" ") || undefined
    );
  }
}
