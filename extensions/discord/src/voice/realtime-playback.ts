import { MessageChannel } from "node:worker_threads";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceAudioOutputPort,
  isRealtimeVoiceAudioAudible,
  realtimeVoiceAudioDurationMs,
  resolveRealtimeVoiceBargeIn,
  type RealtimeVoiceActivationNameTranscriptResult,
  type RealtimeVoiceAudioChunkMetadata,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoicePlaybackItem,
  type RealtimeVoiceSessionHarness,
} from "openclaw/plugin-sdk/realtime-voice";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  DISCORD_CONTINUOUS_CLOCK_BYTES,
  DISCORD_CONTINUOUS_ACTIVE,
  DISCORD_CONTINUOUS_SOURCE_BYTES,
  DISCORD_CONTINUOUS_EXACT_SPEECH,
  restoreDiscordAudioError,
  type DiscordAudioEvent,
} from "./audio-worker-protocol.js";
import { DiscordRealtimeOutput } from "./realtime-output.js";
import type { DiscordRealtimePlayer } from "./realtime-player.js";
import type { DiscordVoiceMode, VoiceSessionEntry } from "./session.js";

const logger = createSubsystemLogger("discord/voice");
const DISCORD_REALTIME_CONTROL_SPEECH_DEDUPE_MS = 5_000;
const DISCORD_REALTIME_MAX_RETAINED_RESPONSES = 32;
const DISCORD_REALTIME_MAX_RETAINED_EXACT_SPEECH_BYTES = 32 * 1024;
const DISCORD_REALTIME_WAKE_ACKS = ["Yeah.", "Mm-hmm.", "Got it.", "One sec."];
const DISCORD_RAW_PCM_FRAME_BYTES = 3_840;
// Discord consumes one frame every 20 ms; cap retained-ahead PCM at two minutes.
const DISCORD_REALTIME_MAX_PENDING_OUTPUT_BYTES = DISCORD_RAW_PCM_FRAME_BYTES * 6_000;

type DiscordRealtimeVoiceConfig = NonNullable<DiscordAccountConfig["voice"]>["realtime"];

type RealtimeExactSpeechState =
  | { status: "idle" }
  | {
      status: "active";
      message: string;
      output?: DiscordRealtimeOutput;
      direct?: { clock: BigInt64Array; epoch: bigint };
    };

function normalizeControlSpeechText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export type DiscordRealtimePlaybackPort = Pick<
  DiscordRealtimePlayback<unknown>,
  | "enqueueExactSpeechMessage"
  | "deliverRetainedSpeech"
  | "handleBargeIn"
  | "hasInterruptibleOutputAudio"
  | "isBargeInEnabled"
  | "isOutputAudioActive"
  | "outputAudioMs"
  | "retainedExactSpeechTexts"
  | "sendWakeNameAck"
  | "speakControlResult"
>;

export class DiscordRealtimePlayback<TState> {
  private outputClearGeneration = 0;
  private directOutput?: { id: number; clock: BigInt64Array; close: () => void };
  private readonly outputs = new Set<DiscordRealtimeOutput>();
  private readonly generatingItems = new Map<string, RealtimeVoicePlaybackItem>();
  private generatingOutput: DiscordRealtimeOutput | undefined;
  private responseAudio: "accepting" | "discarding" | "completed" = "completed";
  private readonly unregisterPlayerLane: () => void;
  private queuedExactSpeechMessages: string[] = [];
  private speechSuccessor: Pick<DiscordRealtimePlaybackPort, "deliverRetainedSpeech"> | undefined;
  private retainedSpeechClosed = false;
  private exactSpeechState: RealtimeExactSpeechState = { status: "idle" };
  private nextExactSpeechEpoch = 0n;
  private pendingDirectCompletion: number | undefined;
  private wakeNameAckIndex = 0;
  private lastControlSpeech:
    | { normalizedText: string; sentAt: number; assistantTranscriptCount: number }
    | undefined;
  constructor(
    private readonly params: {
      bridge: () => RealtimeVoiceBridgeSession | null;
      bridgeReady: () => boolean;
      buildSpeakExactMessage: (text: string) => string;
      entry: VoiceSessionEntry;
      player: DiscordRealtimePlayer;
      harness: RealtimeVoiceSessionHarness<TState>;
      markProviderGenerationObserved: () => void;
      mode: Exclude<DiscordVoiceMode, "stt-tts">;
      onTerminalError: (error: Error) => void;
      providerId: () => string | undefined;
      realtimeConfig: () => DiscordRealtimeVoiceConfig;
      stopTerminally: () => void;
      stopped: () => boolean;
      wakeNameRequired: () => boolean;
    },
  ) {
    this.unregisterPlayerLane = this.params.player.registerLane({
      hasOutput: () => this.isOutputAudioActive(),
      onBargeIn: (reason) => this.handleBargeIn(reason),
      cancelForControl: () => this.cancelForControl(),
    });
  }

  /** Only continuous provider media uses this generation-scoped, PCM24k mono port. */
  createOutputAudioPort(enabled = true): RealtimeVoiceAudioOutputPort {
    this.directOutput?.close();
    const { port1, port2 } = new MessageChannel();
    const id = this.params.entry.audio.allocateId();
    const state = new Int32Array(new SharedArrayBuffer(4));
    const clock = new BigInt64Array(new SharedArrayBuffer(DISCORD_CONTINUOUS_CLOCK_BYTES));
    const unregister = this.params.player.registerOutput(id, (reason) =>
      this.handleBargeIn(reason),
    );
    const onEvent = (event: DiscordAudioEvent) => {
      if (!("id" in event) || event.id !== id || this.directOutput?.id !== id) {
        return;
      }
      if (
        (event.type === "continuous-start" || event.type === "continuous-idle") &&
        this.exactSpeechState.status === "active" &&
        this.exactSpeechState.direct &&
        event.speechEpoch !== this.exactSpeechState.direct.epoch
      ) {
        return;
      }
      if (event.type === "continuous-error") {
        this.stopAfterPlaybackFailure("direct-output-error", restoreDiscordAudioError(event.error));
      }
      if (event.type === "continuous-start") {
        this.params.harness.outputActivity.markPlaybackStarted();
      }
      if (event.type === "continuous-flushed" && event.marker === this.pendingDirectCompletion) {
        this.pendingDirectCompletion = undefined;
        this.responseAudio = "completed";
        this.completeExactSpeechResponse("provider-completed");
      }
      if (event.type === "continuous-idle") {
        this.responseAudio = "completed";
        this.params.harness.finishOutputAudio("player-idle");
        this.params.harness.outputActivity.reset();
        this.completeExactSpeechResponse("player-idle");
      }
    };
    const close = () => {
      Atomics.store(state, 0, 1);
      this.params.entry.audio.off("event", onEvent);
      unregister();
      this.params.entry.audio.send({ type: "continuous-close", id });
      if (this.directOutput?.id === id) {
        this.directOutput = undefined;
      }
    };
    this.directOutput = { id, clock, close };
    this.params.entry.audio.on("event", onEvent);
    this.params.entry.audio.send(
      {
        type: "continuous-port",
        id,
        enabled,
        port: port1,
        state: state.buffer,
        clock: clock.buffer,
      },
      [port1],
    );
    return { port: port2, state: state.buffer };
  }

  activateOutputAudioPort(): void {
    if (this.directOutput) {
      this.params.entry.audio.send({ type: "continuous-activate", id: this.directOutput.id });
    }
  }

  close(preserveUnplayedSpeech = false): void {
    this.unregisterPlayerLane();
    if (preserveUnplayedSpeech) {
      this.retireExactSpeech(true);
    } else {
      this.retainedSpeechClosed = true;
      this.speechSuccessor = undefined;
      this.queuedExactSpeechMessages = [];
      this.retireExactSpeech();
    }
    this.clearOutputAudio("session-close");
    this.directOutput?.close();
  }

  transferPendingSpeechTo(
    target: Pick<DiscordRealtimePlaybackPort, "deliverRetainedSpeech">,
  ): void {
    this.speechSuccessor = target;
    const pending = this.queuedExactSpeechMessages;
    this.queuedExactSpeechMessages = [];
    for (const text of pending) {
      target.deliverRetainedSpeech(text);
    }
  }

  handleBargeIn(reason = "barge-in"): boolean {
    if (!this.isBargeInEnabled()) {
      logger.info(
        `discord voice: realtime barge-in ignored reason=${reason} bargeIn=false guild=${this.params.entry.guildId} channel=${this.params.entry.channelId}`,
      );
      return false;
    }
    const outputActive = this.hasInterruptibleOutputAudio();
    if (!outputActive) {
      logger.info(
        `discord voice: realtime barge-in ignored reason=${reason} outputActive=false guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} playbackChunks=${this.params.harness.outputActivity.snapshot().chunks}`,
      );
      return false;
    }
    logger.info(
      `discord voice: realtime barge-in requested reason=${reason} guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} outputAudioMs=${this.outputAudioMs()} outputActive=${this.isOutputAudioActive()} playbackChunks=${this.params.harness.outputActivity.snapshot().chunks}`,
    );
    // A native handler may decline short audio as echo. Providers without one
    // still need local interruption when another speaker owns the incoming audio.
    const clearGeneration = this.outputClearGeneration;
    const bridge = this.params.bridge();
    const outputs = Array.from(this.outputs);
    const items = Array.from(this.generatingItems.values());
    this.params.harness.handleBargeIn({ audioPlaybackActive: true }, () => {
      if (!bridge?.bridge.handleBargeIn) {
        this.clearOutputAudio(reason);
      }
    });
    return (
      clearGeneration !== this.outputClearGeneration ||
      outputs.some((output) => !this.outputs.has(output)) ||
      items.some((item) => this.generatingItems.get(item.itemId) !== item)
    );
  }

  isBargeInEnabled(): boolean {
    if (this.params.wakeNameRequired()) {
      return false;
    }
    const providerId =
      this.params.providerId() ?? this.params.realtimeConfig()?.provider ?? "openai";
    const realtimeConfig = this.params.realtimeConfig();
    return resolveRealtimeVoiceBargeIn({
      capabilities: this.params.bridge()?.capabilities,
      outputAudioMode: this.params.bridge()?.bridge.outputAudioMode,
      configuredBargeIn: realtimeConfig?.bargeIn,
      interruptResponseOnInputAudio:
        realtimeConfig?.providers?.[providerId]?.interruptResponseOnInputAudio,
    });
  }

  hasInterruptibleOutputAudio(): boolean {
    // Installed providers without playback snapshots retain the scalar clock contract.
    this.params.bridge()?.setMediaTimestamp(this.outputAudioMs());
    return this.isOutputAudioActive();
  }

  getPlaybackState(): RealtimeVoicePlaybackItem[] {
    const items = new Set<RealtimeVoicePlaybackItem>();
    for (const output of this.outputs) {
      const outputItems = output.playbackItems();
      // A starved item precedes later items in its response, even after its
      // resource closes. Older completed responses still keep their queue position.
      if (outputItems.some((item) => this.generatingItems.get(item.itemId) === item)) {
        for (const item of this.generatingItems.values()) {
          items.add(item);
        }
      }
      for (const item of outputItems) {
        items.add(item);
      }
    }
    // Starvation can close a resource before its native response finishes. The
    // response retains consumed offsets until later PCM resumes or generation ends.
    for (const item of this.generatingItems.values()) {
      items.add(item);
    }
    return Array.from(items, (item) => ({ ...item, audioEndMs: Math.floor(item.audioEndMs) }));
  }

  beginResponse(): void {
    // Own a response before PCM arrives without reopening already cancelled output.
    if (this.responseAudio === "completed") {
      this.responseAudio = "accepting";
    }
  }

  sendOutputMark(acknowledge: () => void): void {
    if (!this.params.stopped() && this.responseAudio === "accepting") {
      this.generatingOutput?.markPlayback(acknowledge);
    }
  }

  sendOutputAudio(realtimePcm24kMono: Buffer, metadata?: RealtimeVoiceAudioChunkMetadata): void {
    if (this.params.stopped() || this.responseAudio === "discarding") {
      return;
    }
    if (this.generatingOutput && !this.generatingOutput.isAcceptingAudio()) {
      this.generatingOutput = undefined;
    }
    const audible =
      !this.isContinuousOutput() ||
      isRealtimeVoiceAudioAudible(realtimePcm24kMono, REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ);
    // Once speech opens an output, preserve quiet PCM until that output retires.
    if (!audible && !this.generatingOutput) {
      return;
    }
    this.params.markProviderGenerationObserved();
    if (realtimePcm24kMono.length === 0) {
      return;
    }
    this.params.bridge()?.setMediaTimestamp(this.outputAudioMs());
    const pendingBytes = Array.from(this.outputs).reduce(
      (total, output) => total + output.pendingBytes(),
      0,
    );
    if (
      realtimePcm24kMono.length * 4 > DISCORD_REALTIME_MAX_PENDING_OUTPUT_BYTES - pendingBytes ||
      (!this.generatingOutput && this.outputs.size >= DISCORD_REALTIME_MAX_RETAINED_RESPONSES)
    ) {
      this.stopAfterPlaybackFailure(
        "output-audio-overflow",
        new Error(
          `Discord realtime audio playback overflow: responses=${this.outputs.size} pendingBytes=${pendingBytes} incomingBytes=${realtimePcm24kMono.length * 4}`,
        ),
      );
      return;
    }
    this.beginResponse();
    const output = this.generatingOutput ?? this.createOutput();
    const activity = {
      audioMs: realtimeVoiceAudioDurationMs(
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
        realtimePcm24kMono.byteLength,
      ),
      sourceAudioBytes: realtimePcm24kMono.length,
      sinkAudioBytes: realtimePcm24kMono.length * 4,
    };
    let item: RealtimeVoicePlaybackItem | undefined;
    if (metadata) {
      item = this.generatingItems.get(metadata.itemId);
      if (!item) {
        item = { itemId: metadata.itemId, audioEndMs: 0 };
        this.generatingItems.set(metadata.itemId, item);
      }
    }
    // Observers may interrupt synchronously; publish ownership before notifying them.
    const onAccepted = () => this.params.harness.recordOutputAudio(realtimePcm24kMono, activity);
    if (!output.append(realtimePcm24kMono, audible, item, onAccepted)) {
      this.generatingOutput = undefined;
      this.sendOutputAudio(realtimePcm24kMono, metadata);
    }
  }

  clearOutputAudio(reason = "clear"): void {
    this.outputClearGeneration += 1;
    this.retireExactSpeech();
    if (this.isContinuousOutput()) {
      this.responseAudio = "completed";
    } else if (this.responseAudio === "accepting") {
      this.responseAudio = "discarding";
    }
    this.generatingOutput = undefined;
    this.generatingItems.clear();
    const outputs = Array.from(this.outputs);
    this.outputs.clear();
    // Retire all source ownership and queued requests before stopping its player.
    for (const output of outputs.toReversed()) {
      output.close(reason);
    }
    this.params.harness.outputActivity.reset();
    if (this.directOutput) {
      if (reason === "session-close" || this.params.stopped()) {
        this.directOutput.close();
      } else {
        this.params.entry.audio.send({ type: "continuous-clear", id: this.directOutput.id });
      }
    }
    this.completeExactSpeechResponse(reason);
  }

  handleResponseDone(outcome: {
    status: "completed" | "cancelled" | "failed" | "incomplete";
  }): void {
    // A port round trip drains preceding PCM and also settles a response with no audio.
    if (this.directOutput && outcome.status === "completed") {
      const marker = this.params.entry.audio.allocateId();
      this.pendingDirectCompletion = marker;
      this.params.entry.audio.send({ type: "continuous-flush", id: this.directOutput.id, marker });
      return;
    }
    const output = this.generatingOutput;
    this.generatingOutput = undefined;
    this.generatingItems.clear();
    this.responseAudio = "completed";
    // Generation ends before queued playback. Only this response may end its stream.
    output?.finish(outcome.status, outcome.status === "completed");
    this.completeExactSpeechResponse(outcome.status);
  }

  enqueueExactSpeechMessage(text: string): void {
    if (this.params.stopped() || !this.retainExactSpeechMessage(text)) {
      return;
    }
    this.drainQueuedExactSpeechMessages("enqueue");
  }

  deliverRetainedSpeech(text: string): void {
    if (this.retainedSpeechClosed) {
      return;
    }
    if (this.speechSuccessor) {
      this.speechSuccessor.deliverRetainedSpeech(text);
    } else if (this.retainExactSpeechMessage(text)) {
      this.drainQueuedExactSpeechMessages("handoff");
    }
  }

  /** Accept completed consult ownership without starting provider work during transport cleanup. */
  private retainExactSpeechMessage(text: string): boolean {
    if (!text.trim()) {
      return false;
    }
    const retainedMessages =
      this.queuedExactSpeechMessages.length + (this.exactSpeechState.status === "active" ? 1 : 0);
    const retainedBytes =
      this.queuedExactSpeechMessages.reduce(
        (total, message) => total + Buffer.byteLength(message, "utf8"),
        0,
      ) +
      Buffer.byteLength(
        this.exactSpeechState.status === "active" ? this.exactSpeechState.message : "",
        "utf8",
      );
    const incomingBytes = Buffer.byteLength(text, "utf8");
    if (
      retainedMessages >= DISCORD_REALTIME_MAX_RETAINED_RESPONSES ||
      retainedBytes + incomingBytes > DISCORD_REALTIME_MAX_RETAINED_EXACT_SPEECH_BYTES
    ) {
      // Completed speech cannot be silently dropped. Overflow terminally retires
      // this session before late provider or playback events can drain stale work.
      this.stopAfterPlaybackFailure(
        "exact-speech-overflow",
        new Error(
          `Discord realtime exact speech overflow: retained=${retainedMessages} retainedBytes=${retainedBytes} incomingBytes=${incomingBytes}`,
        ),
      );
      return false;
    }
    this.queuedExactSpeechMessages.push(text);
    logger.info(
      `discord voice: realtime exact speech queued guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} queued=${this.queuedExactSpeechMessages.length} outputAudioMs=${this.outputAudioMs()} outputActive=${this.isOutputAudioActive()}`,
    );
    return true;
  }

  retainedExactSpeechTexts(): string[] {
    return [
      ...(this.exactSpeechState.status === "active" ? [this.exactSpeechState.message] : []),
      ...this.queuedExactSpeechMessages,
    ];
  }

  drainQueuedExactSpeechMessages(reason: string): void {
    if (
      this.params.stopped() ||
      !this.params.bridgeReady() ||
      this.responseAudio !== "completed" ||
      this.exactSpeechState.status === "active" ||
      this.queuedExactSpeechMessages.length === 0 ||
      this.hasInterruptibleOutputAudio()
    ) {
      return;
    }
    const next = this.queuedExactSpeechMessages.shift();
    if (!next) {
      return;
    }
    logger.info(
      `discord voice: realtime exact speech dequeued reason=${reason} guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} queued=${this.queuedExactSpeechMessages.length}`,
    );
    this.sendExactSpeechMessage(next);
  }

  sendWakeNameAck(result: RealtimeVoiceActivationNameTranscriptResult): void {
    if (!result.allowed || this.params.stopped() || this.exactSpeechState.status === "active") {
      return;
    }
    if (this.params.player.isActive() || this.hasInterruptibleOutputAudio()) {
      logger.info(
        `discord voice: realtime wake-name ack skipped outputActive=true voiceSession=${this.params.entry.voiceSessionKey} agent=${this.params.entry.route.agentId}`,
      );
      return;
    }
    const ack =
      DISCORD_REALTIME_WAKE_ACKS[this.wakeNameAckIndex % DISCORD_REALTIME_WAKE_ACKS.length];
    this.wakeNameAckIndex += 1;
    logger.info(
      `discord voice: realtime wake-name ack canonical=${result.activationName} heard=${result.heardName} match=${result.match} voiceSession=${this.params.entry.voiceSessionKey} agent=${this.params.entry.route.agentId}`,
    );
    this.enqueueExactSpeechMessage(ack ?? "Yeah.");
  }

  speakControlResult(text: string): void {
    const trimmed = text.trim();
    if (this.params.stopped() || !trimmed) {
      return;
    }
    this.params.player.cancelForControl();
    this.lastControlSpeech = {
      normalizedText: normalizeControlSpeechText(trimmed),
      sentAt: Date.now(),
      assistantTranscriptCount: 0,
    };
    this.enqueueExactSpeechMessage(trimmed);
  }

  private cancelForControl(): void {
    this.queuedExactSpeechMessages = [];
    this.retireExactSpeech();
    // Idle providers may retain their last audio item; forcing interruption can truncate it.
    if (this.responseAudio === "completed" && !this.isOutputAudioActive()) {
      return;
    }
    if (this.isContinuousOutput()) {
      // Explicit room control clears local speech; it is not a microphone barge-in
      // or an unsupported provider truncate/cancel request.
      this.params.harness.flushOutput(() => this.clearOutputAudio("active-run-control"));
      return;
    }
    this.params.harness.handleBargeIn({ audioPlaybackActive: true, force: true }, () =>
      this.clearOutputAudio("active-run-control"),
    );
  }

  suppressDuplicateControlSpeech(text: string): void {
    const recent = this.lastControlSpeech;
    if (!recent) {
      return;
    }
    if (Date.now() - recent.sentAt > DISCORD_REALTIME_CONTROL_SPEECH_DEDUPE_MS) {
      this.lastControlSpeech = undefined;
      return;
    }
    if (normalizeControlSpeechText(text) !== recent.normalizedText) {
      return;
    }
    recent.assistantTranscriptCount += 1;
    if (recent.assistantTranscriptCount <= 1) {
      return;
    }
    logger.info(
      `discord voice: realtime duplicate active-run control speech suppressed guild=${this.params.entry.guildId} channel=${this.params.entry.channelId}`,
    );
    this.params.harness.handleBargeIn({ audioPlaybackActive: true, force: true }, () =>
      this.clearOutputAudio("duplicate-active-run-control"),
    );
  }

  resetProviderContinuity(reason: string): void {
    this.lastControlSpeech = undefined;
    this.retireExactSpeech(true);
    this.responseAudio = "discarding";
    this.params.harness.flushOutput(() => this.clearOutputAudio(reason));
    this.responseAudio = "completed";
    this.params.harness.finishOutputAudio(reason);
  }

  private retireExactSpeech(preserveUnplayed = false): void {
    this.pendingDirectCompletion = undefined;
    const speech = this.exactSpeechState;
    this.exactSpeechState = { status: "idle" };
    if (speech.status !== "active") {
      return;
    }
    // Retirement races the worker start atomically, not its queued notification to main.
    const directStarted =
      speech.direct &&
      Atomics.exchange(speech.direct.clock, DISCORD_CONTINUOUS_EXACT_SPEECH, 0n) ===
        -speech.direct.epoch;
    if (preserveUnplayed && !directStarted && !speech.output?.activity.snapshot().playbackStarted) {
      this.queuedExactSpeechMessages.unshift(speech.message);
    }
  }

  outputAudioMs(): number {
    return this.directOutput
      ? Math.floor(
          Number(Atomics.load(this.directOutput.clock, DISCORD_CONTINUOUS_SOURCE_BYTES)) / 48,
        )
      : Math.floor(this.params.harness.outputActivity.snapshot().audioMs);
  }

  isOutputAudioActive(): boolean {
    return (
      this.outputs.size > 0 ||
      this.generatingItems.size > 0 ||
      (this.directOutput !== undefined &&
        Atomics.load(this.directOutput.clock, DISCORD_CONTINUOUS_ACTIVE) > 0n)
    );
  }

  private isContinuousOutput(): boolean {
    return this.params.bridge()?.bridge.outputAudioMode === "continuous";
  }

  private stopAfterPlaybackFailure(reason: string, error: Error): void {
    this.retainedSpeechClosed = true;
    this.speechSuccessor = undefined;
    this.params.stopTerminally();
    this.queuedExactSpeechMessages = [];
    this.retireExactSpeech();
    this.clearOutputAudio(reason);
    this.params.onTerminalError(error);
  }

  private createOutput(): DiscordRealtimeOutput {
    const logContext = `guild=${this.params.entry.guildId} channel=${this.params.entry.channelId}`;
    const output = new DiscordRealtimeOutput({
      player: this.params.player,
      logContext,
      continuous: this.isContinuousOutput(),
      onStart: () => {
        this.params.harness.outputActivity.markPlaybackStarted();
        const config = this.params.realtimeConfig();
        logger.info(
          `discord voice: realtime audio playback started ${logContext} mode=${this.params.mode} model=${config?.model ?? "provider-default"} voice=${config?.speakerVoice ?? config?.speakerVoiceId ?? "provider-default"}`,
        );
      },
      onClose: (closed, reason) => {
        if (!this.outputs.delete(closed)) {
          return;
        }
        if (this.generatingOutput === closed) {
          this.generatingOutput = undefined;
          if (reason !== "player-idle") {
            this.responseAudio = "discarding";
          }
        }
        if (this.outputs.size === 0) {
          // A retiring resource may already have handed generation to a successor.
          if (reason === "player-idle" && this.isContinuousOutput()) {
            this.responseAudio = "completed";
            this.generatingItems.clear();
            this.params.harness.finishOutputAudio(reason);
          }
          this.params.harness.outputActivity.reset();
        }
        this.completeExactSpeechResponse(reason);
      },
      onBargeIn: (reason) => this.handleBargeIn(reason),
      onError: (error) =>
        this.stopAfterPlaybackFailure(
          "output-playback-error",
          error instanceof Error ? error : new Error(formatErrorMessage(error)),
        ),
    });
    if (this.outputs.size === 0) {
      this.params.harness.outputActivity.markStreamOpened();
    }
    this.outputs.add(output);
    this.generatingOutput = output;
    if (this.exactSpeechState.status === "active") {
      this.exactSpeechState.output ??= output;
    }
    return output;
  }

  private sendExactSpeechMessage(text: string): void {
    if (this.params.stopped() || !text.trim()) {
      return;
    }
    const direct = this.directOutput
      ? { clock: this.directOutput.clock, epoch: ++this.nextExactSpeechEpoch }
      : undefined;
    this.exactSpeechState = { status: "active", message: text, direct };
    if (direct) {
      Atomics.store(direct.clock, DISCORD_CONTINUOUS_EXACT_SPEECH, direct.epoch);
    }
    this.beginResponse();
    this.params.bridge()?.sendUserMessage(this.params.buildSpeakExactMessage(text));
  }

  private completeExactSpeechResponse(reason: string): void {
    if (
      this.pendingDirectCompletion !== undefined ||
      this.responseAudio !== "completed" ||
      this.isOutputAudioActive()
    ) {
      return;
    }
    this.retireExactSpeech();
    this.drainQueuedExactSpeechMessages(reason);
  }
}
