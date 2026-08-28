import { PassThrough } from "node:stream";
import type { OpenClawConfig, DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { MAX_AUDIO_BYTES } from "openclaw/plugin-sdk/media-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import type { Client } from "../internal/discord.js";
import { decodeOpusStreamChunks, writeVoiceWavFile } from "./audio.js";
import {
  beginVoiceCapture,
  clearVoiceCaptureFinalizeTimer,
  finishVoiceCapture,
  getActiveVoiceCapture,
  isVoiceCaptureActive,
  scheduleVoiceCaptureFinalize,
} from "./capture-state.js";
import { type DiscordVoiceIngressContext, runDiscordVoiceAgentTurn } from "./ingress.js";
import { formatVoiceLogPreview } from "./log-preview.js";
import type { DiscordVoiceMembershipTracker } from "./membership.js";
import { resolveDiscordVoiceIngressContextWithParticipants } from "./participant-context.js";
import {
  analyzeVoiceReceiveError,
  DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS,
  DECRYPT_FAILURE_WINDOW_MS,
  enableDaveReceivePassthrough as tryEnableDaveReceivePassthrough,
  finishVoiceDecryptRecovery,
  noteVoiceDecryptFailure,
  recoverDaveZeroTransition as tryRecoverDaveZeroTransition,
  resetVoiceReceiveRecoveryState,
} from "./receive-recovery.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";
import { processDiscordVoiceSegment, respondToDiscordVoiceTranscript } from "./segment.js";
import {
  CAPTURE_FINALIZE_GRACE_MS,
  logVoiceVerbose,
  MIN_SEGMENT_SECONDS,
  resolveVoiceTimeoutMs,
  type VoiceOperationResult,
  type VoiceJoinOptions,
  type VoiceRealtimeSpeakerTurn,
  type VoiceSessionEntry,
} from "./session.js";
import type { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";

const logger = createSubsystemLogger("discord/voice");

export class DiscordVoiceReceive {
  readonly daveRecoveryAttempts = new Map<string, number>();

  constructor(
    private readonly params: {
      accountId: string;
      admissionAllowFrom?: string[];
      botUserId: () => string | undefined;
      cfg: OpenClawConfig;
      client: Client;
      discordConfig: DiscordAccountConfig;
      getSession: (guildId: string) => VoiceSessionEntry | undefined;
      isEntryCurrent: (entry: VoiceSessionEntry) => boolean;
      isFollowOwnedGuild: (guildId: string) => boolean;
      join: (
        params: { guildId: string; channelId: string },
        options?: VoiceJoinOptions,
      ) => Promise<VoiceOperationResult>;
      leave: (
        params: { guildId: string },
        options?: { preserveFollowState?: boolean },
      ) => Promise<VoiceOperationResult>;
      membership: DiscordVoiceMembershipTracker;
      runtime: RuntimeEnv;
      speakerContext: DiscordVoiceSpeakerContextResolver;
    },
  ) {}

  getRecoveryAttempt(guildId: string): number | undefined {
    return this.daveRecoveryAttempts.get(guildId);
  }

  deleteRecoveryAttempt(guildId: string): void {
    this.daveRecoveryAttempts.delete(guildId);
  }

  clearRecoveryAttempts(): void {
    this.daveRecoveryAttempts.clear();
  }

  scheduleCaptureFinalize(entry: VoiceSessionEntry, userId: string, reason: string): void {
    const graceMs = resolveVoiceTimeoutMs(
      this.params.discordConfig.voice?.captureSilenceGraceMs,
      CAPTURE_FINALIZE_GRACE_MS,
    );
    scheduleVoiceCaptureFinalize({
      state: entry.capture,
      userId,
      delayMs: graceMs,
      onFinalize: () => {
        logVoiceVerbose(
          `capture finalize: guild ${entry.guildId} channel ${entry.channelId} user ${userId} reason=${reason} grace=${graceMs}ms`,
        );
      },
    });
  }

  async handleSpeakingStart(entry: VoiceSessionEntry, userId: string): Promise<void> {
    if (!userId || !this.params.isEntryCurrent(entry)) {
      return;
    }

    const botUserId = this.params.botUserId();
    if (botUserId && userId === botUserId) {
      return;
    }
    this.params.membership.notePresent(entry, userId);
    if (isVoiceCaptureActive(entry.capture, userId)) {
      const activeCapture = getActiveVoiceCapture(entry.capture, userId);
      const extended = activeCapture
        ? clearVoiceCaptureFinalizeTimer(entry.capture, userId, activeCapture.generation)
        : false;
      logVoiceVerbose(
        `capture start ignored (already active): guild ${entry.guildId} channel ${entry.channelId} user ${userId}${extended ? " (finalize canceled)" : ""}`,
      );
      return;
    }

    const capture = entry.transcripts;
    const realtime =
      entry.realtimeLifecycle.status === "active" ? entry.realtimeLifecycle.instance : undefined;
    const playing = entry.player.state.status === loadDiscordVoiceSdk().AudioPlayerStatus.Playing;
    const conversationAllowed = !entry.captureOnly && !(playing && !realtime?.isBargeInEnabled());
    if (!capture && !conversationAllowed) {
      logVoiceVerbose(
        `capture ignored: guild ${entry.guildId} channel ${entry.channelId} user ${userId} reason=${playing ? "protected playback" : "inactive capture"}`,
      );
      return;
    }
    // Without a recording capability realtime input still waits for native command admission.
    const ingress =
      realtime && !capture
        ? await this.resolveDiscordVoiceIngressContext(entry, userId)
        : undefined;
    if (!capture && realtime && !ingress) {
      logVoiceVerbose(
        `realtime capture unauthorized: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      return;
    }
    if (!this.params.isEntryCurrent(entry) || isVoiceCaptureActive(entry.capture, userId)) {
      return;
    }
    await this.receiveSpeaker(entry, userId, conversationAllowed, ingress);
  }

  captureCurrentSpeakers(entry: VoiceSessionEntry): void {
    for (const userId of entry.connection.receiver.speaking.users.keys()) {
      void this.handleSpeakingStart(entry, userId).catch((error: unknown) =>
        logger.warn(`discord voice: capture failed: ${formatErrorMessage(error)}`),
      );
    }
  }

  async processSegment(params: {
    entry: VoiceSessionEntry;
    wavPath: string;
    userId: string;
    durationSeconds: number;
    ingressContext?: DiscordVoiceIngressContext | null;
    recording?: Parameters<typeof processDiscordVoiceSegment>[0]["recording"];
    onTranscript?: (text: string) => void;
  }): Promise<void> {
    await processDiscordVoiceSegment({
      ...this.segmentContext(params.entry, params.userId),
      ...params,
    });
  }

  private segmentContext(entry: VoiceSessionEntry, userId: string) {
    return {
      entry,
      userId,
      accountId: this.params.accountId,
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
      admissionAllowFrom: this.params.admissionAllowFrom,
      runtime: this.params.runtime,
      speakerContext: this.params.speakerContext,
      resolveIngressContext: () => this.resolveDiscordVoiceIngressContext(entry, userId),
      fetchGuildName: async (guildId: string) => {
        const guild = await this.params.client.fetchGuild(guildId).catch(() => null);
        return guild && typeof guild.name === "string" && guild.name.trim()
          ? guild.name
          : undefined;
      },
      enqueuePlayback: (playbackEntry: VoiceSessionEntry, task: () => Promise<void>) => {
        playbackEntry.playbackQueue = playbackEntry.playbackQueue
          .then(task)
          .catch((err: unknown) =>
            logger.warn(`discord voice: playback failed: ${formatErrorMessage(err)}`),
          );
      },
    };
  }

  private async receiveSpeaker(
    entry: VoiceSessionEntry,
    userId: string,
    conversationAllowed: boolean,
    admittedIngress?: DiscordVoiceIngressContext | null,
  ): Promise<void> {
    const voiceSdk = loadDiscordVoiceSdk();
    const realtime =
      entry.realtimeLifecycle.status === "active" ? entry.realtimeLifecycle.instance : undefined;
    const protectedPlayback = () =>
      entry.player.state.status === voiceSdk.AudioPlayerStatus.Playing &&
      !realtime?.isBargeInEnabled();
    this.enableDaveReceivePassthrough(
      entry,
      `speaker ${userId} start`,
      DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS,
    );
    const stream = entry.connection.receiver.subscribe(userId, {
      end: { behavior: voiceSdk.EndBehaviorType.Manual },
    });
    const generation = beginVoiceCapture(entry.capture, userId, stream);
    // Reserve packets before identity/decoder awaits. Normal socket close ends this owned input
    // without destroying packets already received under the source subscription.
    const input = new PassThrough({ objectMode: true });
    type PacketReceipt = { capture: VoiceSessionEntry["transcripts"]; startedAt: number };
    const receipts = new WeakMap<Buffer, PacketReceipt>();
    let ingress: DiscordVoiceIngressContext | null = admittedIngress ?? null;
    let turn: VoiceRealtimeSpeakerTurn | undefined;
    const acceptPacket = (packet: Buffer) => {
      if (
        !this.params.isEntryCurrent(entry) ||
        getActiveVoiceCapture(entry.capture, userId)?.generation !== generation
      ) {
        return;
      }
      const capture = entry.transcripts;
      if (!capture && !conversationAllowed) {
        return;
      }
      const receivedPacket = Buffer.from(packet);
      receipts.set(receivedPacket, { capture, startedAt: Date.now() });
      input.write(receivedPacket);
    };
    const endInput = () => input.end();
    let failed = false;
    let aborted = false;
    const onError = (error: unknown) => {
      const analysis = analyzeVoiceReceiveError(error);
      aborted ||= analysis.isAbortLike;
      if (failed) {
        return;
      }
      failed = !analysis.isAbortLike;
      this.handleReceiveError(entry, error);
    };
    stream.on("data", acceptPacket);
    stream.on("end", endInput);
    stream.on("close", endInput);
    stream.on("error", onError);
    let speaker: Promise<{ label: string }> | undefined;
    const admission = (async () => {
      const context = conversationAllowed
        ? (admittedIngress ?? (await this.resolveDiscordVoiceIngressContext(entry, userId)))
        : null;
      if (!context || !this.params.isEntryCurrent(entry) || protectedPlayback()) {
        return;
      }
      ingress = context;
      if (realtime) {
        if (entry.player.state.status === voiceSdk.AudioPlayerStatus.Playing) {
          realtime.handleBargeIn("speaker-start");
        }
        turn = realtime.beginSpeakerTurn(context, userId);
      }
    })();
    const audio = this.params.cfg.tools?.media?.audio;
    const models = this.params.cfg.tools?.media?.models ?? [];
    const maxBytes = Math.min(
      MAX_AUDIO_BYTES,
      audio?.maxBytes ?? MAX_AUDIO_BYTES,
      ...models
        .filter((model) => !model.capabilities || model.capabilities.includes("audio"))
        .map((model) => model.maxBytes ?? MAX_AUDIO_BYTES),
    );
    // WAV header + complete stereo PCM frames stay below the configured upload caps.
    const segmentBytes = Math.max(4, Math.floor((maxBytes - 44) / 4) * 4);
    let chunks: Buffer[] = [];
    let bytes = 0;
    const conversationTexts: string[] = [];
    let segmentCapture: VoiceSessionEntry["transcripts"];
    let startedAt = 0;
    const pcmBytesPerMillisecond = (48_000 * 2 * 2) / 1_000;
    const flush = async () => {
      if (!bytes) {
        return;
      }
      const pcm = Buffer.concat(chunks, bytes);
      const timestamp = startedAt;
      const capture = segmentCapture;
      chunks = [];
      bytes = 0;
      const canConverse = () => !realtime && ingress !== null && this.params.isEntryCurrent(entry);
      if (failed || (!capture?.isCurrent() && !canConverse())) {
        return;
      }
      if (
        !capture &&
        pcm.length / (pcmBytesPerMillisecond * 1_000) < (aborted ? 0.2 : MIN_SEGMENT_SECONDS)
      ) {
        return;
      }
      const recording = capture
        ? {
            capture,
            startedAt: timestamp,
            speaker: (speaker ??= this.params.speakerContext.resolveIdentity(
              entry.guildId,
              userId,
            )),
          }
        : undefined;
      const wav = await writeVoiceWavFile(pcm);
      // Only paths wait behind STT; live PCM is released after bounded WAV materialization.
      entry.processingQueue = entry.processingQueue
        .then(async () => {
          try {
            await this.processSegment({
              entry,
              wavPath: wav.path,
              durationSeconds: wav.durationSeconds,
              userId,
              // Batch commands revalidate native authorization after the queue wait.
              ingressContext: canConverse() ? undefined : null,
              recording,
              onTranscript: (text) => {
                conversationTexts.push(text);
              },
            });
          } finally {
            await wav.cleanup();
          }
        })
        .catch((error: unknown) =>
          logger.warn(`discord voice: recording failed: ${formatErrorMessage(error)}`),
        );
    };
    try {
      await decodeOpusStreamChunks(input, {
        onChunk: async (pcm, packet) => {
          const receipt = receipts.get(packet);
          if (!receipt || failed) {
            return;
          }
          await admission;
          if (pcm.length > 0) {
            this.resetDecryptFailureState(entry);
          }
          if (this.params.isEntryCurrent(entry)) {
            turn?.sendInputAudio(pcm);
          }
          if (receipt.capture !== segmentCapture) {
            await flush();
          }
          segmentCapture = receipt.capture;
          if (
            !segmentCapture?.isCurrent() &&
            (realtime || !ingress || !this.params.isEntryCurrent(entry))
          ) {
            return;
          }
          for (let offset = 0; offset < pcm.length;) {
            if (!bytes) {
              startedAt = receipt.startedAt + offset / pcmBytesPerMillisecond;
            }
            // Recording is bounded; uncaptured batch conversation keeps its existing utterance boundary.
            const limit = segmentCapture ? segmentBytes : Number.POSITIVE_INFINITY;
            const length = Math.min(limit - bytes, pcm.length - offset);
            chunks.push(pcm.subarray(offset, offset + length));
            bytes += length;
            offset += length;
            if (bytes === limit) {
              await flush();
            }
          }
        },
        onError,
        onVerbose: logVoiceVerbose,
        onWarn: (message) => logger.warn(message),
      });
      await admission;
      await flush();
      // Recording chunks share STT text, but only speech finalization delivers a batch command.
      if (!failed && !realtime && conversationAllowed) {
        entry.processingQueue = entry.processingQueue
          .then(async () => {
            if (!conversationTexts.length || !this.params.isEntryCurrent(entry)) {
              return;
            }
            const currentIngress = await this.resolveDiscordVoiceIngressContext(entry, userId);
            if (!currentIngress || !this.params.isEntryCurrent(entry)) {
              return;
            }
            await respondToDiscordVoiceTranscript({
              ...this.segmentContext(entry, userId),
              ingress: currentIngress,
              transcript: conversationTexts.join("\n"),
            });
          })
          .catch((error: unknown) =>
            logger.warn(`discord voice: processing failed: ${formatErrorMessage(error)}`),
          );
      }
    } finally {
      turn?.close();
      stream.off("data", acceptPacket);
      stream.off("end", endInput);
      stream.off("close", endInput);
      stream.off("error", onError);
      input.destroy();
      if (finishVoiceCapture(entry.capture, userId, generation) && !stream.destroyed) {
        stream.destroy();
      }
    }
  }

  handleReceiveError(entry: VoiceSessionEntry, err: unknown): void {
    const analysis = analyzeVoiceReceiveError(err);
    if (analysis.isAbortLike && !analysis.countsAsDecryptFailure) {
      logVoiceVerbose(`receive stream ended: ${analysis.message}`);
      return;
    }
    if (analysis.isDecodeCorruption && !analysis.countsAsDecryptFailure) {
      logVoiceVerbose(`receive decode skipped: ${analysis.message}`);
      return;
    }
    logger.warn(`discord voice: receive error: ${analysis.message}`);
    if (analysis.shouldAttemptPassthrough) {
      if (this.params.isEntryCurrent(entry)) {
        const recovery = tryRecoverDaveZeroTransition({
          target: entry,
          sdk: loadDiscordVoiceSdk(),
          onWarn: (message) => logger.warn(message),
        });
        if (recovery === "failed") {
          this.startDecryptRecovery(entry, true);
          return;
        }
      }
      this.enableDaveReceivePassthrough(
        entry,
        "receive decrypt error",
        DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS,
      );
    }
    if (!analysis.countsAsDecryptFailure) {
      return;
    }
    const decryptFailure = noteVoiceDecryptFailure(entry.receiveRecovery);
    if (decryptFailure.firstFailure) {
      logger.warn(
        "discord voice: DAVE decrypt failures detected; voice receive may be unstable (upstream: discordjs/discord.js#11419)",
      );
    }
    if (!decryptFailure.shouldRecover) {
      return;
    }
    this.startDecryptRecovery(entry);
  }

  enableDaveReceivePassthrough(
    entry: Pick<VoiceSessionEntry, "guildId" | "channelId" | "connection">,
    reason: string,
    expirySeconds: number,
  ): boolean {
    const voiceSdk = loadDiscordVoiceSdk();
    return tryEnableDaveReceivePassthrough({
      target: {
        guildId: entry.guildId,
        channelId: entry.channelId,
        connection: entry.connection as {
          state: {
            status: unknown;
            networking?: {
              state?: {
                code?: unknown;
                dave?: {
                  session?: {
                    setPassthroughMode: (passthrough: boolean, expirySeconds: number) => void;
                  };
                };
              };
            };
          };
        },
      },
      sdk: {
        VoiceConnectionStatus: {
          Ready: voiceSdk.VoiceConnectionStatus.Ready,
        },
        NetworkingStatusCode: {
          Ready: voiceSdk.NetworkingStatusCode.Ready,
          Resuming: voiceSdk.NetworkingStatusCode.Resuming,
        },
      },
      reason,
      expirySeconds,
      onVerbose: logVoiceVerbose,
      onWarn: (message) => logger.warn(message),
    });
  }

  private async resolveDiscordVoiceIngressContext(
    entry: VoiceSessionEntry,
    userId: string,
  ): Promise<DiscordVoiceIngressContext | null> {
    return await resolveDiscordVoiceIngressContextWithParticipants({
      client: this.params.client,
      entry,
      userId,
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
      admissionAllowFrom: this.params.admissionAllowFrom,
      botUserId: this.params.botUserId(),
      speakerContext: this.params.speakerContext,
    });
  }

  async runDiscordRealtimeAgentTurn(params: {
    context: {
      extraSystemPrompt?: string;
      senderIsOwner: boolean;
      speakerLabel: string;
    };
    entry: VoiceSessionEntry;
    message: string;
    toolsAllow?: string[];
    userId: string;
  }): Promise<string> {
    const { context, entry, message, toolsAllow, userId } = params;
    logger.info(
      `discord voice: agent turn start guild=${entry.guildId} channel=${entry.channelId} voiceSession=${entry.voiceSessionKey} supervisorSession=${entry.route.sessionKey} agent=${entry.route.agentId} user=${userId} speaker=${context.speakerLabel} owner=${context.senderIsOwner} model=${this.params.discordConfig.voice?.model ?? "route-default"} message=${formatVoiceLogPreview(message)}`,
    );
    const turn = await runDiscordVoiceAgentTurn({
      entry,
      accountId: this.params.accountId,
      userId,
      message,
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
      runtime: this.params.runtime,
      context,
      toolsAllow,
      admissionAllowFrom: this.params.admissionAllowFrom,
      fetchGuildName: async (guildId) => {
        const guild = await this.params.client.fetchGuild(guildId).catch(() => null);
        return guild && typeof guild.name === "string" && guild.name.trim()
          ? guild.name
          : undefined;
      },
      speakerContext: this.params.speakerContext,
    });
    if (!turn) {
      logVoiceVerbose(
        `realtime agent unauthorized: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      return "";
    }
    logger.info(
      `discord voice: agent turn answer (${turn.text.length} chars) guild=${entry.guildId} channel=${entry.channelId} voiceSession=${entry.voiceSessionKey} supervisorSession=${entry.route.sessionKey} agent=${entry.route.agentId}: ${formatVoiceLogPreview(turn.text)}`,
    );
    return turn.text;
  }

  private startDecryptRecovery(entry: VoiceSessionEntry, force = false): void {
    let recovery: Promise<unknown>;
    if (force) {
      if (
        this.params.getSession(entry.guildId) !== entry ||
        entry.sessionLifecycle.status === "stopped" ||
        entry.receiveRecovery.decryptRecoveryInFlight
      ) {
        return;
      }
      const now = Date.now();
      for (const [guildId, attemptedAt] of this.daveRecoveryAttempts) {
        if (now - attemptedAt >= DECRYPT_FAILURE_WINDOW_MS) {
          this.daveRecoveryAttempts.delete(guildId);
        }
      }
      resetVoiceReceiveRecoveryState(entry.receiveRecovery);
      entry.receiveRecovery.decryptRecoveryInFlight = true;
      if (this.daveRecoveryAttempts.has(entry.guildId)) {
        const windowSeconds = DECRYPT_FAILURE_WINDOW_MS / 1_000;
        logger.warn(
          `discord voice: DAVE recovery failed again within ${windowSeconds} seconds; disconnecting guild=${entry.guildId} channel=${entry.channelId} to avoid a reconnect loop; retry /vc join after the voice gateway recovers`,
        );
        recovery = this.params.leave(
          { guildId: entry.guildId },
          { preserveFollowState: this.params.isFollowOwnedGuild(entry.guildId) },
        );
      } else {
        // A partially invalidated DAVE session suppresses all later decrypt failures.
        this.daveRecoveryAttempts.set(entry.guildId, now);
        recovery = this.recoverFromDecryptFailures(entry);
      }
    } else {
      recovery = this.recoverFromDecryptFailures(entry);
    }
    void recovery
      .catch((recoverErr: unknown) =>
        logger.warn(`discord voice: decrypt recovery failed: ${formatErrorMessage(recoverErr)}`),
      )
      .finally(() => {
        finishVoiceDecryptRecovery(entry.receiveRecovery);
      });
  }

  private resetDecryptFailureState(entry: VoiceSessionEntry): void {
    resetVoiceReceiveRecoveryState(entry.receiveRecovery);
    if (this.params.isEntryCurrent(entry)) {
      this.daveRecoveryAttempts.delete(entry.guildId);
    }
  }

  private async recoverFromDecryptFailures(entry: VoiceSessionEntry): Promise<void> {
    const active = this.params.getSession(entry.guildId);
    if (!active || active.connection !== entry.connection) {
      return;
    }
    const preserveFollowState = this.params.isFollowOwnedGuild(entry.guildId);
    logger.warn(
      `discord voice: repeated decrypt failures; attempting rejoin for guild ${entry.guildId} channel ${entry.channelId}`,
    );
    const leaveResult = await this.params.leave(
      { guildId: entry.guildId },
      { preserveFollowState },
    );
    if (!leaveResult.ok) {
      logger.warn(`discord voice: decrypt recovery leave failed: ${leaveResult.message}`);
      return;
    }
    const result = await this.params.join(
      { guildId: entry.guildId, channelId: entry.channelId },
      {
        preserveFollowState,
        autoJoinWhenOccupied: entry.autoJoinWhenOccupied,
        captureOnly: entry.captureOnly,
      },
    );
    if (!result.ok) {
      logger.warn(`discord voice: rejoin after decrypt failures failed: ${result.message}`);
    }
  }
}
