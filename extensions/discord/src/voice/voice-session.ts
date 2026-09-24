import type { OpenClawConfig, DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import type { Client } from "../internal/discord.js";
import type { VoicePlugin } from "../internal/voice.js";
import { formatMention } from "../mentions.js";
import { getDiscordRuntime } from "../runtime.js";
import { createDiscordAudioTransport, type DiscordAudioTransport } from "./audio-transport.js";
import { createVoiceCaptureState, stopVoiceCaptureState } from "./capture-state.js";
import { resolveDiscordVoiceRealtimeBootstrapContext } from "./ingress.js";
import type { DiscordVoiceMembershipTracker } from "./membership.js";
import {
  createVoiceReceiveRecoveryState,
  DAVE_RECEIVE_PASSTHROUGH_INITIAL_EXPIRY_SECONDS,
} from "./receive-recovery.js";
import {
  CAPTURE_FINALIZE_GRACE_MS,
  isDiscordRealtimeVoiceMode,
  isVoiceChannel,
  logVoiceVerbose,
  resolveDiscordVoiceMode,
  resolveVoiceTimeoutMs,
  VOICE_CONNECT_READY_TIMEOUT_MS,
  VOICE_RECONNECT_GRACE_MS,
  type DiscordVoiceMode,
  type VoiceJoinOptions,
  type VoiceOperationResult,
  type VoiceSessionGeneration,
  type VoiceSessionEntry,
} from "./session.js";
import { DiscordVoiceConversationQueue } from "./voice-conversation-input.js";
import type { DiscordVoiceReceive } from "./voice-receive.js";
import { resolveDiscordVoiceAgentRoute } from "./voice-route.js";

const logger = createSubsystemLogger("discord/voice");

function isVoiceSessionStopped(entry: VoiceSessionEntry): boolean {
  return entry.sessionLifecycle.status === "stopped";
}

export class DiscordVoiceSessions {
  private readonly pendingStops = new Set<Promise<void>>();
  private readonly transports = new Map<string, DiscordAudioTransport>();

  async stopTransport(guildId: string, audio = this.transports.get(guildId)): Promise<void> {
    if (!audio) {
      return;
    }
    // Keep the retiring owner discoverable until its final gateway leave and
    // worker exit settle; a replacement must not overtake physical shutdown.
    await audio.stop();
    if (this.transports.get(guildId) === audio) {
      this.transports.delete(guildId);
    }
  }

  constructor(
    private readonly params: {
      accountId: string;
      botUserId: () => string | undefined;
      cfg: OpenClawConfig;
      client: Client;
      destroyed: () => boolean;
      getTranscripts: (entry: {
        guildId: string;
        channelId: string;
      }) => VoiceSessionEntry["transcripts"];
      discordConfig: DiscordAccountConfig;
      membership: DiscordVoiceMembershipTracker;
      onLeaveFollowState: (guildId: string) => void;
      onSessionStopped: (entry: VoiceSessionEntry, reason: string) => void;
      receive: DiscordVoiceReceive;
      sessions: Map<string, VoiceSessionEntry>;
    },
  ) {}

  async waitForStops(): Promise<void> {
    await Promise.allSettled(
      [...this.transports.keys()].map((guildId) => this.stopTransport(guildId)),
    );
    await Promise.allSettled(this.pendingStops);
  }

  refreshGuildRoster(guildId: string): void {
    const entry = this.params.sessions.get(guildId.trim());
    if (!entry || entry.sessionLifecycle.status === "stopped") {
      return;
    }
    this.params.membership.activate(entry, this.params.botUserId());
  }

  async resolveChannel({
    guildId,
    channelId,
  }: {
    guildId: string;
    channelId: string;
  }): Promise<
    | { ok: true; value: Awaited<ReturnType<Client["fetchChannel"]>> }
    | { ok: false; error: VoiceOperationResult }
  > {
    let channelInfo: Awaited<ReturnType<Client["fetchChannel"]>>;
    try {
      channelInfo = await this.params.client.fetchChannel(channelId);
    } catch (err) {
      return {
        ok: false,
        error: {
          ok: false,
          message: `Failed to resolve Discord channel ${channelId}: ${formatErrorMessage(err)}`,
          guildId,
          channelId,
        },
      };
    }
    if (!isVoiceChannel(channelInfo.type)) {
      return {
        ok: false,
        error: { ok: false, message: `Channel ${channelId} is not a voice channel.` },
      };
    }
    const channelGuildId = "guildId" in channelInfo ? channelInfo.guildId : undefined;
    if (channelGuildId && channelGuildId !== guildId) {
      return { ok: false, error: { ok: false, message: "Voice channel is not in this guild." } };
    }
    return { ok: true, value: channelInfo };
  }

  async joinUnlocked(
    params: { guildId: string; channelId: string },
    options?: VoiceJoinOptions,
    authority?: VoiceSessionGeneration,
  ): Promise<VoiceOperationResult> {
    const { guildId, channelId } = params;
    const voiceConfig = this.params.discordConfig.voice;
    const voiceMode = resolveDiscordVoiceMode(voiceConfig);
    const cancelledJoinResult = (): VoiceOperationResult => ({
      ok: false,
      message: "Discord voice join was cancelled.",
      guildId,
      channelId,
    });

    const existing = this.params.sessions.get(guildId);
    if (existing && existing.channelId === channelId) {
      if (authority) {
        existing.generation = authority.generation;
      }
      if (
        (!options?.captureOnly || !existing.captureOnly) &&
        isDiscordRealtimeVoiceMode(voiceMode) &&
        existing.realtimeLifecycle.status !== "active" &&
        existing.realtimeLifecycle.status !== "starting"
      ) {
        const realtimeResult = await this.attachRealtimeSession(existing, voiceMode, {
          requireLiveEntry: true,
          isCurrent: authority?.isCurrent,
        });
        if (!realtimeResult.ok) {
          return {
            ok: false,
            message: realtimeResult.message,
            guildId,
            channelId,
          };
        }
      }
      logVoiceVerbose(`join: already connected to guild ${guildId} channel ${channelId}`);
      return {
        ok: true,
        message: `Already connected to ${formatMention({ channelId })}.`,
        guildId,
        channelId,
      };
    }
    if (existing) {
      logVoiceVerbose(`join: replacing existing session for guild ${guildId}`);
      await this.leave({ guildId }, { preserveFollowState: options?.preserveFollowState });
    }

    const resolved = await this.resolveChannel(params);
    // Leave or replacement wins over a lookup that failed after this join lost ownership.
    if (authority && !authority.isCurrent()) {
      return cancelledJoinResult();
    }
    if (!resolved.ok) {
      return resolved.error;
    }
    const channelInfo = resolved.value;

    const voicePlugin = this.params.client.getPlugin<VoicePlugin>("voice");
    if (!voicePlugin) {
      return { ok: false, message: "Discord voice plugin is not available." };
    }

    const audioInputBudget = await getDiscordRuntime().mediaUnderstanding.resolveAudioInputBudget({
      cfg: this.params.cfg,
    });
    if (authority && !authority.isCurrent()) {
      return cancelledJoinResult();
    }
    const adapterCreator = voicePlugin.getGatewayAdapterCreator(guildId);
    const daveEncryption = voiceConfig?.daveEncryption;
    const decryptionFailureTolerance = voiceConfig?.decryptionFailureTolerance;
    const connectReadyTimeoutMs = resolveVoiceTimeoutMs(
      voiceConfig?.connectTimeoutMs,
      VOICE_CONNECT_READY_TIMEOUT_MS,
    );
    const reconnectGraceMs = resolveVoiceTimeoutMs(
      voiceConfig?.reconnectGraceMs,
      VOICE_RECONNECT_GRACE_MS,
    );
    logVoiceVerbose(
      `join: DAVE settings encryption=${daveEncryption === false ? "off" : "on"} tolerance=${
        decryptionFailureTolerance ?? "default"
      } connectTimeout=${connectReadyTimeoutMs}ms reconnectGrace=${reconnectGraceMs}ms`,
    );
    await this.stopTransport(guildId);
    // Leave/destroy can win while the previous worker is releasing its sockets.
    // Revalidate before a replacement can send a new voice-state update.
    if (this.params.destroyed() || authority?.isCurrent() === false) {
      return cancelledJoinResult();
    }
    const audio = createDiscordAudioTransport(
      {
        guildId,
        channelId,
        group: "openclaw:" + this.params.accountId,
        selfDeaf: false,
        selfMute: false,
        daveEncryption,
        decryptionFailureTolerance,
        connectTimeoutMs: connectReadyTimeoutMs,
        reconnectGraceMs,
        captureSilenceGraceMs: resolveVoiceTimeoutMs(
          voiceConfig?.captureSilenceGraceMs,
          CAPTURE_FINALIZE_GRACE_MS,
        ),
        realtime: isDiscordRealtimeVoiceMode(voiceMode),
      },
      adapterCreator,
    );
    this.transports.set(guildId, audio);
    try {
      await audio.ready;
    } catch (error) {
      await this.stopTransport(guildId);
      return {
        ok: false,
        message: "Failed to join voice channel: " + formatErrorMessage(error),
        guildId,
        channelId,
      };
    }
    if (this.params.destroyed() || authority?.isCurrent() === false) {
      await this.stopTransport(guildId);
      return cancelledJoinResult();
    }

    const sessionChannelId = channelInfo?.id ?? channelId;
    // Use the voice channel id as the session channel so text chat in the voice channel
    // shares the same session as spoken audio.
    if (sessionChannelId !== channelId) {
      logVoiceVerbose(
        `join: using session channel ${sessionChannelId} for voice channel ${channelId}`,
      );
    }
    let routeInfo: ReturnType<typeof resolveDiscordVoiceAgentRoute>;
    try {
      routeInfo = resolveDiscordVoiceAgentRoute({
        cfg: this.params.cfg,
        accountId: this.params.accountId,
        guildId,
        sessionChannelId,
        voiceConfig,
      });
    } catch (err) {
      await this.stopTransport(guildId);
      return {
        ok: false,
        message: `Failed to resolve Discord voice agent session: ${formatErrorMessage(err)}`,
        guildId,
        channelId,
      };
    }
    const { route, voiceRoute, agentSessionMode, agentSessionTarget } = routeInfo;
    logger.info(
      `discord voice: joining guild=${guildId} channel=${channelId} mode=${voiceMode} agent=${route.agentId} voiceSession=${voiceRoute.sessionKey} supervisorSession=${route.sessionKey} agentSessionMode=${agentSessionMode}${agentSessionTarget ? ` agentSessionTarget=${agentSessionTarget}` : ""} voiceModel=${voiceConfig?.model ?? "route-default"} realtimeProvider=${voiceConfig?.realtime?.provider ?? "auto"} realtimeModel=${voiceConfig?.realtime?.model ?? "provider-default"} realtimeVoice=${voiceConfig?.realtime?.speakerVoice ?? voiceConfig?.realtime?.speakerVoiceId ?? "provider-default"}`,
    );

    let stopCompletion: Promise<void> | undefined;
    const stopEntry = (optionsLocal: { reason: string }): void | Promise<void> => {
      if (entry.sessionLifecycle.status === "stopped") {
        return stopCompletion;
      }
      entry.sessionLifecycle = { status: "stopped", reason: optionsLocal.reason };
      // A late callback from an old connection must not remove its replacement.
      if (this.params.sessions.get(guildId) === entry) {
        this.params.sessions.delete(guildId);
      }
      this.params.membership.deactivate(entry);
      audio.off("speaking", speakingHandler);
      stopVoiceCaptureState(entry.capture);
      audio.off("stopped", destroyedHandler);
      const realtimeLifecycle = entry.realtimeLifecycle;
      entry.realtimeLifecycle = {
        status: "stopped",
        generation: realtimeLifecycle.generation,
        reason: optionsLocal.reason,
      };
      let realtimeCompletion: void | Promise<void> = undefined;
      try {
        if (realtimeLifecycle.status === "starting" || realtimeLifecycle.status === "active") {
          realtimeCompletion = realtimeLifecycle.instance.close();
        }
      } catch (error) {
        logger.warn(`discord voice: realtime close failed: ${formatErrorMessage(error)}`);
      }
      const audioCompletion = this.stopTransport(guildId, audio);
      stopCompletion = Promise.allSettled([realtimeCompletion, audioCompletion]).then(() => {
        entry.conversations.close();
        this.params.onSessionStopped(entry, optionsLocal.reason);
      });
      const completion = stopCompletion;
      this.pendingStops.add(completion);
      const forget = () => {
        this.pendingStops.delete(completion);
      };
      void completion.then(forget, (error: unknown) => {
        forget();
        logger.warn(`discord voice: session stop failed: ${formatErrorMessage(error)}`);
      });
      return stopCompletion;
    };

    const getTranscripts = this.params.getTranscripts;
    const entry: VoiceSessionEntry = {
      generation: authority?.generation ?? 0,
      captureOnly: options?.captureOnly === true,
      autoJoinWhenOccupied: options?.autoJoinWhenOccupied === true,
      sessionLifecycle: { status: "active" },
      guildId,
      guildName:
        channelInfo &&
        "guild" in channelInfo &&
        channelInfo.guild &&
        typeof channelInfo.guild.name === "string"
          ? channelInfo.guild.name
          : undefined,
      channelId,
      channelName:
        channelInfo && "name" in channelInfo && typeof channelInfo.name === "string"
          ? channelInfo.name
          : undefined,
      sessionChannelId,
      voiceSessionKey: voiceRoute.sessionKey,
      route,
      audio,
      playbackQueue: Promise.resolve(),
      processingQueue: Promise.resolve(),
      conversations: new DiscordVoiceConversationQueue(),
      audioInputBudget,
      ttsStreamFallbackWarned: false,
      capture: createVoiceCaptureState(),
      get transcripts(): VoiceSessionEntry["transcripts"] {
        return getTranscripts(entry);
      },
      receiveRecovery: createVoiceReceiveRecoveryState(),
      realtimeLifecycle: { status: "inactive", generation: 0 },
      stop(reason) {
        return stopEntry({
          reason: reason ?? `stop guild ${guildId} channel ${channelId}`,
        });
      },
    };

    const speakingHandler = (userId: string, speaking: boolean) => {
      if (speaking) {
        void this.params.receive.handleSpeakingStart(entry, userId).catch((error: unknown) => {
          logger.warn("discord voice: capture failed: " + formatErrorMessage(error));
        });
      } else {
        this.params.receive.scheduleCaptureFinalize(entry, userId, "speaker end");
      }
    };
    const destroyedHandler = () => {
      void stopEntry({ reason: "audio worker stopped" });
    };
    audio.on("stopped", destroyedHandler);
    if (!entry.captureOnly && isDiscordRealtimeVoiceMode(voiceMode)) {
      const realtimeResult = await this.attachRealtimeSession(entry, voiceMode, {
        isCurrent: authority?.isCurrent,
      });
      if (!realtimeResult.ok) {
        await entry.stop(`realtime setup failed guild ${guildId} channel ${channelId}`);
        return {
          ok: false,
          message: realtimeResult.message,
          guildId,
          channelId,
        };
      }
    }
    if (
      isVoiceSessionStopped(entry) ||
      this.params.destroyed() ||
      (authority && !authority.isCurrent())
    ) {
      await entry.stop(
        `${this.params.destroyed() ? "manager stopped" : "join cancelled"} during setup guild ${guildId} channel ${channelId}`,
      );
      return {
        ok: false,
        message: this.params.destroyed()
          ? "Discord voice manager is stopped."
          : "Discord voice join was cancelled.",
        guildId,
        channelId,
      };
    }

    entry.audio.enablePassthrough(
      "post-join warmup",
      DAVE_RECEIVE_PASSTHROUGH_INITIAL_EXPIRY_SECONDS,
    );
    audio.on("speaking", speakingHandler);

    this.params.sessions.set(guildId, entry);
    this.params.membership.activate(entry, this.params.botUserId());
    logger.info(
      `discord voice: joined guild=${guildId} channel=${channelId} mode=${voiceMode} agent=${route.agentId} voiceSession=${voiceRoute.sessionKey} supervisorSession=${route.sessionKey} voiceModel=${voiceConfig?.model ?? "route-default"}`,
    );
    return {
      ok: true,
      message: `Joined ${formatMention({ channelId })}.`,
      guildId,
      channelId,
    };
  }

  async leave(
    params: { guildId: string; channelId?: string },
    options?: { preserveFollowState?: boolean },
  ): Promise<VoiceOperationResult> {
    const guildId = params.guildId.trim();
    logVoiceVerbose(`leave requested: guild ${guildId} channel ${params.channelId ?? "current"}`);
    const entry = this.params.sessions.get(guildId);
    if (!entry) {
      return { ok: false, message: "Not connected to a voice channel." };
    }
    if (params.channelId && params.channelId !== entry.channelId) {
      return { ok: false, message: "Not connected to that voice channel." };
    }
    const stopped = entry.stop();
    if (!entry.receiveRecovery.decryptRecoveryInFlight) {
      this.params.receive.daveRecoveryAttempts.delete(guildId);
    }
    if (!options?.preserveFollowState) {
      this.params.onLeaveFollowState(guildId);
    }
    await stopped;
    logVoiceVerbose(`leave: disconnected from guild ${guildId} channel ${entry.channelId}`);
    return {
      ok: true,
      message: `Left ${formatMention({ channelId: entry.channelId })}.`,
      guildId,
      channelId: entry.channelId,
    };
  }

  private async attachRealtimeSession(
    entry: VoiceSessionEntry,
    voiceMode: Exclude<DiscordVoiceMode, "stt-tts">,
    options?: { requireLiveEntry?: boolean; isCurrent?: () => boolean },
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const bootstrapContextInstructions = await resolveDiscordVoiceRealtimeBootstrapContext({
      entry,
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
    });
    if (
      entry.sessionLifecycle.status === "stopped" ||
      options?.isCurrent?.() === false ||
      (options?.requireLiveEntry === true && this.params.sessions.get(entry.guildId) !== entry)
    ) {
      return {
        ok: false,
        message: "Discord realtime voice session stopped before startup completed.",
      };
    }
    const { DiscordRealtimeVoiceSession } = await import("./realtime-session.runtime.js");
    const realtime = new DiscordRealtimeVoiceSession({
      accountId: this.params.accountId,
      bootstrapContextInstructions,
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
      entry,
      getHumanParticipantCount: () =>
        this.params.membership.countHumanParticipants(entry, this.params.botUserId()),
      mode: voiceMode,
      onTerminalError: (error) => {
        logger.error(
          `discord voice: realtime session failed terminally guild=${entry.guildId} channel=${entry.channelId}: ${formatErrorMessage(error)}`,
        );
        const lifecycle = entry.realtimeLifecycle;
        if (
          options?.requireLiveEntry &&
          lifecycle.status === "starting" &&
          lifecycle.instance === realtime
        ) {
          // Failed promotion retires only its realtime attempt. The already-ready
          // receiver still belongs to the previous capture or conversation owner.
          entry.realtimeLifecycle = {
            status: "stopped",
            generation: lifecycle.generation,
            reason: "realtime terminal error",
          };
          void realtime.close();
        } else {
          void entry.stop("realtime terminal error");
        }
      },
      runAgentTurn: (turn) => this.params.receive.runDiscordRealtimeAgentTurn({ ...turn, entry }),
      resolveSpeakerContext: (userId) =>
        this.params.receive.resolveDiscordVoiceIngressContext(entry, userId),
    });
    const generation = entry.realtimeLifecycle.generation + 1;
    entry.realtimeLifecycle = { status: "starting", generation, instance: realtime };
    try {
      await realtime.connect();
      if (
        entry.realtimeLifecycle.status !== "starting" ||
        entry.realtimeLifecycle.generation !== generation ||
        entry.realtimeLifecycle.instance !== realtime ||
        isVoiceSessionStopped(entry) ||
        options?.isCurrent?.() === false ||
        (options?.requireLiveEntry === true && this.params.sessions.get(entry.guildId) !== entry)
      ) {
        await realtime.close();
        return {
          ok: false,
          message: "Discord realtime voice session stopped before startup completed.",
        };
      }
      entry.realtimeLifecycle = { status: "active", generation, instance: realtime };
      return { ok: true };
    } catch (err) {
      await realtime.close();
      if (
        entry.realtimeLifecycle.status === "starting" &&
        entry.realtimeLifecycle.generation === generation
      ) {
        entry.realtimeLifecycle = {
          status: "stopped",
          generation,
          reason: "connect failed",
        };
      }
      return {
        ok: false,
        message: `Failed to start Discord realtime voice: ${formatErrorMessage(err)}`,
      };
    }
  }
}
