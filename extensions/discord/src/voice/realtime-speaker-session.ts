import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import {
  buildRealtimeVoiceSpeakExactMessage,
  createRealtimeVoiceSessionHarness,
  isRealtimeVoiceWakeNameRequired,
  matchRealtimeVoiceConsultQuestions,
  REALTIME_VOICE_AGENT_CONTROL_TOOL,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  resolveRealtimeVoiceAgentConsultTools,
  type RealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceBridgeEvent,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceCloseDisposition,
  type RealtimeVoiceSelectionInfo,
  type RealtimeVoiceTranscriptEntry,
  type RealtimeVoiceSessionHarness,
  type RealtimeVoiceWakeNamePolicy,
} from "openclaw/plugin-sdk/realtime-voice";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { DiscordVoiceIngressContext } from "./ingress.js";
import {
  formatVoiceLogPreview,
  formatRealtimeInterruptionLog,
  formatRealtimeLifecycleLog,
  shouldLogRealtimeVerboseEvent,
} from "./log-preview.js";
import { DiscordRealtimeConsults, type AgentProxyConsultState } from "./realtime-consults.js";
import { DiscordRealtimePlayback } from "./realtime-playback.js";
import type { DiscordRealtimePlayer } from "./realtime-player.js";
import {
  DiscordRealtimeRecording,
  type DiscordRealtimeRecordingInput,
} from "./realtime-recording.js";
import { resolveDiscordRealtimeSpeakerConfig } from "./realtime-speaker-config.js";
import { DiscordRealtimeTurns } from "./realtime-turns.js";
import {
  logVoiceVerbose,
  type DiscordVoiceMode,
  type VoiceRealtimeAgentTurnParams,
  type VoiceRealtimeSession,
  type VoiceRealtimeSpeakerContext,
  type VoiceRealtimeSpeakerTurn,
  type VoiceSessionEntry,
} from "./session.js";

const logger = createSubsystemLogger("discord/voice");
const DISCORD_REALTIME_DUPLICATE_ERROR_SUPPRESS_MS = 60_000;
const discordRealtimeTalkPayload = () => ({});

type DiscordRealtimeVoiceConfig = NonNullable<DiscordAccountConfig["voice"]>["realtime"];

function isDiscordAgentProxyVoiceMode(mode: DiscordVoiceMode): boolean {
  return mode === "agent-proxy";
}

export type DiscordRealtimeSessionParams = {
  accountId: string;
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  entry: VoiceSessionEntry;
  mode: Exclude<DiscordVoiceMode, "stt-tts">;
  bootstrapContextInstructions?: string;
  getHumanParticipantCount?: () => number;
  onTerminalError: (error: Error) => void;
  runAgentTurn: (params: VoiceRealtimeAgentTurnParams) => Promise<string>;
  resolveSpeakerContext: (userId: string) => Promise<DiscordVoiceIngressContext | null>;
};

export class DiscordRealtimeSpeakerSession implements VoiceRealtimeSession {
  private bridge: RealtimeVoiceBridgeSession | null = null;
  private readonly harness: RealtimeVoiceSessionHarness<AgentProxyConsultState>;
  private readonly playback: DiscordRealtimePlayback<AgentProxyConsultState>;
  private readonly turns: DiscordRealtimeTurns;
  private readonly consults: DiscordRealtimeConsults;
  private readonly recording: DiscordRealtimeRecording;
  private lifecycle: {
    status: "inactive" | "starting" | "active" | "closing" | "stopped";
    generation: number;
  } = { status: "inactive", generation: 0 };
  private consultToolPolicy: RealtimeVoiceAgentConsultToolPolicy = "safe-read-only";
  private consultToolsAllow: string[] | undefined;
  private consultPolicy: "auto" | "always" = "auto";
  private wakeNamePolicy: RealtimeVoiceWakeNamePolicy = "never";
  private wakeNames: string[] = [];
  private realtimeProviderId: string | undefined;
  private handlesAgentConsult = false;
  private providerGenerationObserved = false;
  private providerContinuityEpoch = 0;
  private readonly captures = new Set<VoiceRealtimeSpeakerTurn>();
  private inputOpen = true;
  private closeCompletion: Promise<void> | undefined;
  private activeOperations = 0;
  private outputEnabled = true;
  private selection: RealtimeVoiceSelectionInfo | undefined;
  private readonly inputIdleListeners = new Set<() => void>();
  private lastActivityAt = Date.now();
  private lastRealtimeError:
    | { message: string; suppressed: number; lastLoggedAt: number }
    | undefined;

  constructor(
    private readonly params: DiscordRealtimeSessionParams & {
      player: DiscordRealtimePlayer;
      sessionId: string;
      voiceOverride?: string;
      standby?: boolean;
      conversationHistory?: readonly RealtimeVoiceTranscriptEntry[];
    },
  ) {
    this.outputEnabled = !params.standby;
    this.recording = this.createRecording();
    this.harness = createRealtimeVoiceSessionHarness<AgentProxyConsultState>({
      talk: {
        sessionId: this.params.sessionId,
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
      },
      talkPayloads: {
        turnStarted: discordRealtimeTalkPayload,
        turnEnded: discordRealtimeTalkPayload,
        inputAudioDelta: discordRealtimeTalkPayload,
        outputAudioStarted: discordRealtimeTalkPayload,
        outputAudioDelta: discordRealtimeTalkPayload,
        outputAudioDone: discordRealtimeTalkPayload,
      },
      forcedConsults: {
        limit: 16,
        nativeDedupeMs: 15_000,
        questionsMatch: matchRealtimeVoiceConsultQuestions,
      },
    });
    for (const item of params.conversationHistory ?? []) {
      this.harness.recordTranscript(item.role, item.text);
    }
    this.playback = new DiscordRealtimePlayback({
      bridge: () => this.bridge,
      bridgeReady: () => this.isReady(),
      buildSpeakExactMessage: (text) =>
        buildRealtimeVoiceSpeakExactMessage({
          text,
          surfaceLabel: "the Discord voice channel",
        }),
      entry: this.params.entry,
      player: this.params.player,
      harness: this.harness,
      markProviderGenerationObserved: () => this.markProviderGenerationObserved(),
      mode: this.params.mode,
      onTerminalError: this.params.onTerminalError,
      providerId: () => this.realtimeProviderId,
      realtimeConfig: () => this.realtimeConfig,
      stopTerminally: () => {
        this.lifecycle.status = "stopped";
        this.consults.close();
      },
      stopped: () => this.isStopped(),
      wakeNameRequired: () => this.isWakeNameRequired(),
    });
    this.turns = new DiscordRealtimeTurns({
      bridge: () => this.bridge,
      entry: this.params.entry,
      getHumanParticipantCount: () => this.humanParticipantCount(),
      interruptRoomPlayback: () => {
        if (!this.playback.isBargeInEnabled() || !this.params.player.isActive()) {
          return false;
        }
        return this.params.player.handleBargeIn("active-speaker-audio");
      },
      onAcceptedTranscript: (text, context, providerEpoch) =>
        this.consults.handleAcceptedTranscript(text, context, providerEpoch),
      playback: this.playback,
      providerEpoch: () => this.providerContinuityEpoch,
      providerId: () => this.realtimeProviderId,
      realtimeConfig: () => this.realtimeConfig,
      recordInputAudio: (audio) => this.harness.recordInputAudio(audio),
      stopped: () => this.isStopped(),
      wakeNamePolicy: () => this.wakeNamePolicy,
      wakeNames: () => this.wakeNames,
    });
    this.consults = new DiscordRealtimeConsults({
      accountId: this.params.accountId,
      consultPolicy: () => this.consultPolicy,
      consultToolPolicy: () => this.consultToolPolicy,
      consultToolsAllow: () => this.consultToolsAllow,
      debounceMs: () => this.realtimeConfig?.debounceMs,
      entry: this.params.entry,
      harness: this.harness,
      isAgentProxy: () =>
        isDiscordAgentProxyVoiceMode(this.params.mode) && !this.handlesAgentConsult,
      isWakeNameRequired: () => this.isWakeNameRequired(),
      playback: this.playback,
      providerEpoch: () => this.providerContinuityEpoch,
      runAgentTurn: (turn) => this.trackOperation(() => this.params.runAgentTurn(turn)),
      resolveSpeakerContext: this.params.resolveSpeakerContext,
      stopped: () => this.isStopped(),
      turns: this.turns,
      usesRealtimeAgentHandoff: () =>
        this.params.mode === "bidi" || this.consultToolPolicy !== "none",
      wakeNamePolicy: () => this.wakeNamePolicy,
    });
  }

  async connect(): Promise<void> {
    const lifecycleGeneration = this.lifecycle.generation + 1;
    this.lifecycle = {
      status: "starting",
      generation: lifecycleGeneration,
    };
    const {
      resolved,
      selection,
      sessionPolicy,
      instructions,
      interruptResponseOnInputAudio,
      bargeIn,
      minBargeInAudioEndMs,
      resolvedModel,
      resolvedVoice,
    } = resolveDiscordRealtimeSpeakerConfig({
      accountId: this.params.accountId,
      agentId: this.params.entry.route.agentId,
      cfg: this.params.cfg,
      realtimeConfig: this.realtimeConfig,
      isAgentProxy: isDiscordAgentProxyVoiceMode(this.params.mode),
      bootstrapContextInstructions: this.params.bootstrapContextInstructions,
      voiceOverride: this.params.voiceOverride,
      conversationHistory: this.params.conversationHistory,
    });
    this.realtimeProviderId = resolved.provider.id;
    this.selection = selection;
    const capabilities = resolved.capabilities;
    const {
      toolPolicy,
      consultToolsAllow,
      consultPolicy,
      wakeNamePolicy,
      wakeNames,
      autoRespondToAudio,
    } = sessionPolicy;
    this.handlesAgentConsult = sessionPolicy.handlesAgentConsult;
    this.consultToolPolicy = toolPolicy;
    this.consultToolsAllow = consultToolsAllow;
    this.consultPolicy = consultPolicy;
    this.wakeNamePolicy = wakeNamePolicy;
    this.wakeNames = wakeNames;
    const usesRealtimeAgentHandoff = this.params.mode === "bidi" || toolPolicy !== "none";
    const onReady = () => {
      this.markProviderGenerationObserved();
      if (this.markLifecycleReady(lifecycleGeneration)) {
        this.playback.drainQueuedExactSpeechMessages("provider-ready");
      }
    };
    this.bridge = this.harness.createBridge({
      provider: resolved.provider,
      capabilities,
      cfg: this.params.cfg,
      agentId: this.params.entry.route.agentId,
      providerConfig: resolved.providerConfig,
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      instructions,
      autoRespondToAudio,
      interruptResponseOnInputAudio,
      markStrategy: "transport",
      ...(this.handlesAgentConsult
        ? {
            runAgentConsult: (request) =>
              this.trackOperation(() => this.consults.runAgentConsult(request)),
          }
        : {}),
      tools: usesRealtimeAgentHandoff
        ? resolveRealtimeVoiceAgentConsultTools(
            toolPolicy,
            toolPolicy !== "none" ? [REALTIME_VOICE_AGENT_CONTROL_TOOL] : [],
          )
        : [],
      audioSink: {
        isOpen: () => !this.isStopped() && this.outputEnabled,
        sendAudio: (audio, metadata) => {
          if (this.outputEnabled) {
            this.playback.sendOutputAudio(audio, metadata);
          }
        },
        sendMark: (markName, acknowledge) => {
          if (acknowledge) {
            this.playback.sendOutputMark(acknowledge);
          } else {
            // Installed providers with unscoped marks retain immediate acknowledgments;
            // delaying them could acknowledge a replacement provider connection.
            this.bridge?.acknowledgeMark(markName);
          }
        },
        getPlaybackState: () => this.playback.getPlaybackState(),
        clearAudio: () => {
          this.markProviderGenerationObserved();
          this.harness.flushOutput(() => this.playback.clearOutputAudio("provider-clear-audio"));
        },
      },
      onTranscript: (role, text, isFinal) => {
        if (this.lifecycle.status === "stopped") {
          return;
        }
        if (this.lifecycle.status === "closing") {
          if (role === "user" && isFinal && text.trim()) {
            this.recording.transcript(text.trim());
          }
          return;
        }
        this.markProviderGenerationObserved();
        if (isFinal && text.trim()) {
          logger.info(
            `discord voice: realtime ${role} transcript (${text.length} chars): ${formatVoiceLogPreview(text)}`,
          );
        }
        if (isFinal && role === "assistant") {
          this.playback.suppressDuplicateControlSpeech(text);
        }
        if (role !== "user") {
          return;
        }
        if (!isFinal) {
          this.turns.handlePartialUserTranscript(text);
          return;
        }
        if (text.trim()) {
          this.recording.transcript(text.trim());
        }
        // Provider-owned delegation consumes its own transcript; a final snapshot is not
        // another agent request or a host-controlled speech turn.
        if (this.handlesAgentConsult) {
          return;
        }
        void this.trackOperation(() => this.turns.handleFinalUserTranscript(text)).catch(
          (error: unknown) => this.logRealtimeError(formatErrorMessage(error)),
        );
      },
      onToolCall: (event, session) => {
        if (this.isStopped()) {
          return undefined;
        }
        this.markProviderGenerationObserved();
        return this.trackOperation(() => this.consults.handleToolCall(event, session));
      },
      onReady,
      onEvent: (event) => {
        if (this.isStopped()) {
          return;
        }
        this.handleBridgeEvent(event);
        // Some providers report recovered readiness without repeating onReady.
        if (event.direction === "client" && event.type === "session.reconnect.ready") {
          onReady();
        }
      },
      onResponseDone: (outcome) => {
        if (this.isStopped()) {
          return;
        }
        this.markProviderGenerationObserved();
        this.playback.handleResponseDone(outcome);
        if (outcome.status === "cancelled") {
          logger.info(
            `discord voice: realtime model interrupt confirmed server:response.done status=cancelled${outcome.reason ? ` reason=${outcome.reason}` : ""}`,
          );
        } else if (outcome.status === "failed" || outcome.status === "incomplete") {
          this.logRealtimeError(outcome.message);
        }
      },
      onError: (error) => this.logRealtimeError(formatErrorMessage(error)),
      onClose: (reason) => {
        // Reconnects stay provider-owned. A close is terminal unless local teardown started it.
        if (!this.isStopped()) {
          this.lifecycle.status = "stopped";
          this.params.onTerminalError(
            new Error(`Realtime provider closed unexpectedly: ${reason}`),
          );
        }
      },
    });
    // createBridge may close synchronously, before its returned bridge can be disposed.
    if (this.isStopped()) {
      await this.close();
      return;
    }
    const humanParticipantCount = this.humanParticipantCount();
    logger.info(
      `discord voice: realtime bridge starting mode=${this.params.mode} provider=${resolved.provider.id} model=${resolvedModel ?? "default"} voice=${resolvedVoice ?? "default"} consultPolicy=${consultPolicy} toolPolicy=${toolPolicy} autoRespond=${autoRespondToAudio} wakeNamePolicy=${this.wakeNamePolicy} requireWakeName=${this.isWakeNameRequired(humanParticipantCount)} humanParticipants=${humanParticipantCount} wakeNames=${this.wakeNames.join(",") || "none"} interruptResponse=${interruptResponseOnInputAudio} bargeIn=${bargeIn} minBargeInAudioEndMs=${minBargeInAudioEndMs}`,
    );
    await this.bridge.connect();
    if (!this.markLifecycleReady(lifecycleGeneration)) {
      await this.close();
      return;
    }
    this.markProviderGenerationObserved();
    this.playback.drainQueuedExactSpeechMessages("provider-connected");
    logger.info(
      `discord voice: realtime bridge ready mode=${this.params.mode} provider=${resolved.provider.id} model=${resolvedModel ?? "default"} voice=${resolvedVoice ?? "default"}`,
    );
  }

  close(disposition: RealtimeVoiceCloseDisposition = "abort"): void | Promise<void> {
    if (this.lifecycle.status === "closing" || (!this.bridge && !this.inputOpen)) {
      return this.closeCompletion;
    }
    // Closing admits only final transcripts; provider completion owns their recording frontier.
    this.lifecycle.status = "closing";
    this.drain();
    this.flushSuppressedRealtimeErrors();
    this.consults.close(disposition === "detach");
    this.playback.close(disposition === "detach");
    const finish = () => {
      const dispose = () => {
        this.lifecycle.status = "stopped";
        this.providerContinuityEpoch += 1;
        this.harness.close();
        this.turns.clear();
        this.bridge = null;
        this.realtimeProviderId = undefined;
      };
      const recordingCompletion = this.recording.finish();
      if (recordingCompletion) {
        return recordingCompletion.finally(dispose);
      }
      dispose();
      return undefined;
    };
    let completion: void | Promise<void>;
    try {
      completion = this.bridge?.close(disposition === "detach" ? { disposition } : undefined);
    } catch (error) {
      completion = Promise.reject(toErrorObject(error, "Discord realtime provider cleanup failed"));
    }
    if (completion) {
      this.closeCompletion = completion.then(finish, async (error: unknown) => {
        this.logRealtimeError(formatErrorMessage(error));
        await finish();
        if (disposition === "detach") {
          throw error;
        }
      });
    } else {
      this.closeCompletion = finish();
    }
    return this.closeCompletion;
  }

  beginSpeakerTurn(
    context: VoiceRealtimeSpeakerContext,
    userId: string,
    recordingInput?: DiscordRealtimeRecordingInput,
  ): VoiceRealtimeSpeakerTurn {
    if (!this.inputOpen || this.isStopped()) {
      throw new Error("Discord realtime speaker input is closed");
    }
    const turn = this.turns.beginSpeakerTurn(context, userId);
    if (recordingInput) {
      this.recording.attach(recordingInput, { id: userId, label: context.speakerLabel });
    }
    let closed = false;
    const capture: VoiceRealtimeSpeakerTurn = {
      sendInputAudio: (audio, receipt) => {
        if (!closed) {
          recordingInput?.submit(receipt);
          this.lastActivityAt = Date.now();
          turn.sendInputAudio(audio);
        }
      },
      close: (reason) => {
        if (closed) {
          return;
        }
        closed = true;
        this.captures.delete(capture);
        if (this.captures.size === 0) {
          for (const listener of this.inputIdleListeners) {
            listener();
          }
        }
        this.lastActivityAt = Date.now();
        try {
          if (reason === "incomplete-input") {
            recordingInput?.exclude();
            // Retire this provider connection before a late transcript can dispatch partial speech.
            this.params.onTerminalError(new Error("Discord realtime received incomplete speech."));
          } else {
            turn.close();
          }
        } catch (error) {
          recordingInput?.exclude();
          throw error;
        } finally {
          recordingInput?.sealAudio();
        }
      },
    };
    this.captures.add(capture);
    return capture;
  }

  drain(): void {
    this.inputOpen = false;
    for (const capture of this.captures) {
      capture.close();
    }
  }

  releaseReasonBefore(cutoff: number): "idle" | "input-timeout" | undefined {
    const idle =
      this.lastActivityAt < cutoff &&
      this.captures.size === 0 &&
      this.activeOperations === 0 &&
      this.consults.isIdle() &&
      !this.playback.isOutputAudioActive() &&
      this.playback.retainedExactSpeechTexts().length === 0;
    if (!idle) {
      return undefined;
    }
    // Providers need not emit a transcript for noise. Expire idle input explicitly;
    // retiring the connection fences any delayed final instead of reassigning its owner.
    return this.turns.hasPendingSpeakerAudioContext() ? "input-timeout" : "idle";
  }

  notify(text: string): void {
    this.playback.enqueueExactSpeechMessage(text);
  }

  transferPendingSpeechTo(replacement: DiscordRealtimeSpeakerSession): void {
    this.playback.transferPendingSpeechTo(replacement.playback);
  }

  readVoiceSelection(): RealtimeVoiceSelectionInfo {
    if (!this.selection || !this.isReady()) {
      throw new Error("Discord voice connection is not ready");
    }
    return {
      ...this.selection,
      voices: [...this.selection.voices],
    };
  }

  snapshotConversation(): RealtimeVoiceTranscriptEntry[] {
    const history: RealtimeVoiceTranscriptEntry[] = [];
    let bytes = 0;
    for (const item of this.harness.transcript.slice(-16).toReversed()) {
      const entry = { ...item, text: sliceUtf16Safe(item.text, 0, 800) };
      const size = Buffer.byteLength(
        JSON.stringify(entry).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e"),
        "utf8",
      );
      if (bytes + size > 8_000) {
        break;
      }
      history.unshift(entry);
      bytes += size;
    }
    return history;
  }

  conversationCheckpoint(): RealtimeVoiceTranscriptEntry | undefined {
    return this.harness.transcript.at(-1);
  }

  activateOutput(): void {
    this.readVoiceSelection();
    this.outputEnabled = true;
  }

  hasActiveInput(): boolean {
    return this.captures.size > 0;
  }

  async waitForInputIdle(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.hasActiveInput()) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        this.inputIdleListeners.delete(finish);
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        this.inputIdleListeners.delete(finish);
        reject(toErrorObject(signal?.reason, "Discord voice change cancelled"));
      };
      this.inputIdleListeners.add(finish);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private async trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.activeOperations += 1;
    try {
      return await operation();
    } finally {
      this.activeOperations -= 1;
      this.lastActivityAt = Date.now();
    }
  }

  canReceiveDuringPlayback(): boolean {
    return this.bridge?.bridge.outputAudioMode === "continuous" || this.playback.isBargeInEnabled();
  }

  private get realtimeConfig(): DiscordRealtimeVoiceConfig {
    return this.params.discordConfig.voice?.realtime;
  }

  private isStopped(): boolean {
    return this.lifecycle.status === "closing" || this.lifecycle.status === "stopped";
  }

  private isReady(): boolean {
    return this.lifecycle.status === "active";
  }

  private markLifecycleReady(generation: number): boolean {
    if (
      (this.lifecycle.status !== "starting" && this.lifecycle.status !== "active") ||
      this.lifecycle.generation !== generation
    ) {
      return false;
    }
    this.lifecycle.status = "active";
    return true;
  }

  private humanParticipantCount(): number {
    return this.params.getHumanParticipantCount?.() ?? 0;
  }

  private isWakeNameRequired(humanParticipantCount = this.humanParticipantCount()): boolean {
    return isRealtimeVoiceWakeNameRequired(this.wakeNamePolicy, humanParticipantCount);
  }

  private handleBridgeEvent(event: RealtimeVoiceBridgeEvent): void {
    if (
      !(event.direction === "client" && event.type === "session.continuity.reset") &&
      !event.type.endsWith("audio.delta") &&
      event.type !== "output_audio.rtp"
    ) {
      this.markProviderGenerationObserved();
    }
    const detail = event.detail ? ` ${event.detail}` : "";
    if (event.direction === "client" && event.type === "session.continuity.reset") {
      this.resetProviderContinuity(event.type);
    }
    if (event.direction === "server" && event.type === "response.created") {
      this.playback.beginResponse();
    }
    if (event.direction === "server" && event.type === "input_audio_buffer.speech_started") {
      this.turns.resetPartialWakeNameTracking();
    }
    if (shouldLogRealtimeVerboseEvent(event)) {
      logVoiceVerbose(`realtime ${event.direction}:${event.type}${detail}`);
    }
    const interruptionLog = formatRealtimeInterruptionLog(event);
    if (interruptionLog) {
      logger.info(interruptionLog);
    }
    const lifecycleLog = formatRealtimeLifecycleLog(event);
    if (lifecycleLog) {
      logger.info(lifecycleLog);
    }
  }

  private markProviderGenerationObserved(): void {
    this.lastActivityAt = Date.now();
    this.providerGenerationObserved = true;
  }

  private resetProviderContinuity(reason: string): void {
    if (!this.providerGenerationObserved) {
      return;
    }
    this.providerGenerationObserved = false;
    if (this.lifecycle.status === "active") {
      this.lifecycle.status = "starting";
    }
    this.providerContinuityEpoch += 1;
    // Provider queues may replay earlier input without new Discord send callbacks.
    // Only a fresh speaker connection can establish recording receipts again.
    this.recording.close();
    this.consults.resetProviderContinuity();
    this.turns.resetProviderContinuity();
    this.playback.resetProviderContinuity(reason);
  }

  private createRecording(): DiscordRealtimeRecording {
    const epoch = this.providerContinuityEpoch;
    return new DiscordRealtimeRecording({
      entry: this.params.entry,
      isCurrent: () =>
        this.lifecycle.status !== "stopped" && this.providerContinuityEpoch === epoch,
      warn: (message) => logger.warn(message),
    });
  }

  private logRealtimeError(message: string): void {
    const now = Date.now();
    if (
      this.lastRealtimeError?.message === message &&
      now - this.lastRealtimeError.lastLoggedAt < DISCORD_REALTIME_DUPLICATE_ERROR_SUPPRESS_MS
    ) {
      this.lastRealtimeError.suppressed += 1;
      return;
    }
    this.flushSuppressedRealtimeErrors();
    this.lastRealtimeError = { message, suppressed: 0, lastLoggedAt: now };
    logger.warn(`discord voice: realtime error: ${message}`);
  }

  private flushSuppressedRealtimeErrors(): void {
    if (!this.lastRealtimeError || this.lastRealtimeError.suppressed === 0) {
      return;
    }
    logger.warn(
      `discord voice: suppressed ${this.lastRealtimeError.suppressed} duplicate realtime errors: ${this.lastRealtimeError.message}`,
    );
    this.lastRealtimeError.suppressed = 0;
  }
}
