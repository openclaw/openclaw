/**
 * Teams voice session manager — the TS-side orchestrator for Teams live voice.
 *
 * Mirrors the pattern from DiscordVoiceManager (extensions/discord/src/voice/manager.ts)
 * but delegates call ownership to the .NET media worker. The manager:
 *
 * 1. Negotiates capability tier at startup (live_voice / transcript_mode / text_only).
 * 2. Manages call sessions and their lifecycle states.
 * 3. Bridges audio between the .NET worker and the agent pipeline.
 * 4. Enforces the compliance gate — no audio processing until confirmed.
 */

import { randomUUID } from "node:crypto";
import { agentCommandFromIngress } from "openclaw/plugin-sdk/agent-runtime";
import { resolveAgentDir, resolveTtsConfig } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/infra-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";
import { transcribeAudioFile } from "openclaw/plugin-sdk/media-understanding-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { parseTtsDirectives } from "openclaw/plugin-sdk/speech";
import { textToSpeech } from "openclaw/plugin-sdk/speech-runtime";
import type { MSTeamsConfig } from "../../runtime-api.js";
import { ComplianceGate } from "./compliance-gate.js";
import { resolveTeamsVoiceConfig, type ResolvedTeamsVoiceConfig } from "./config.js";
import type {
  CallEvent,
  TeamsCallSession,
  TeamsCallState,
  TeamsParticipant,
  TeamsVoiceCapabilityTier,
  UnmixedAudioSegment,
  VoiceOperationResult,
} from "./types.js";
import { WorkerBridge } from "./worker-bridge.js";

const logger = createSubsystemLogger("msteams/voice");

const logVoice = (message: string) => {
  logVerbose(`msteams voice: ${message}`);
};

const DEFAULT_ACCOUNT_ID = "msteams";

// Audio constants (matching .NET worker output: 16kHz mono 16-bit)
const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BIT_DEPTH = 16;
const BYTES_PER_SAMPLE = (BIT_DEPTH / 8) * CHANNELS;

export class TeamsVoiceManager {
  private sessions = new Map<string, TeamsCallSession>();
  private bridge: WorkerBridge;
  private complianceGate = new ComplianceGate();
  private voiceConfig: ResolvedTeamsVoiceConfig;
  private capabilityTier: TeamsVoiceCapabilityTier = "text_only";
  private audioSubscriptionCancellers = new Map<string, () => void>();
  private eventSubscriptionCancellers = new Map<string, () => void>();

  constructor(
    private params: {
      cfg: OpenClawConfig;
      msteamsConfig: MSTeamsConfig;
      accountId: string;
      runtime: RuntimeEnv;
    },
  ) {
    this.voiceConfig = resolveTeamsVoiceConfig(params.msteamsConfig.voice);
    this.bridge = new WorkerBridge(this.voiceConfig.workerAddress);
  }

  // ── Public API ────────────────────────────────────────────────────────

  isEnabled(): boolean {
    return this.voiceConfig.enabled;
  }

  getCapabilityTier(): TeamsVoiceCapabilityTier {
    return this.capabilityTier;
  }

  /**
   * Negotiate the capability tier based on worker reachability and config.
   *
   * Called at startup and can be re-called on config change.
   */
  async negotiateCapability(): Promise<TeamsVoiceCapabilityTier> {
    if (!this.voiceConfig.enabled) {
      this.capabilityTier = "text_only";
      return this.capabilityTier;
    }

    // Probe the .NET media worker
    try {
      await this.bridge.connect();
      const healthy = await this.bridge.healthCheck();

      if (healthy) {
        this.capabilityTier = "live_voice";
        logger.info("capability negotiation: live_voice (worker reachable and healthy)");
        return this.capabilityTier;
      }
      logger.warn("capability negotiation: worker reachable but unhealthy, falling back");
    } catch (err) {
      logVoice(`worker probe failed: ${formatErrorMessage(err)}`);
    }

    // Fallback: check if transcript mode is configured
    if (this.voiceConfig.transcriptFallback !== false) {
      this.capabilityTier = "transcript_mode";
      logger.info(
        `capability negotiation: transcript_mode (fallback=${this.voiceConfig.transcriptFallback})`,
      );
      return this.capabilityTier;
    }

    this.capabilityTier = "text_only";
    logger.info("capability negotiation: text_only (no worker, no transcript fallback)");
    return this.capabilityTier;
  }

  /**
   * Join a Teams meeting by join URL.
   *
   * Delegates to the .NET media worker which creates the call via the
   * stateful Graph Communications SDK with appHostedMediaConfig.
   */
  async joinMeeting(params: { joinUrl: string }): Promise<VoiceOperationResult> {
    if (this.capabilityTier !== "live_voice") {
      return {
        ok: false,
        message:
          `Cannot join meeting: capability tier is ${this.capabilityTier}, not live_voice. ` +
          "Ensure a Windows Teams Voice Worker is reachable.",
      };
    }

    const callId = randomUUID();
    logVoice(`joining meeting: ${params.joinUrl} (callId=${callId})`);

    const appId = this.params.msteamsConfig.appId ?? "";
    const tenantId = this.params.msteamsConfig.tenantId ?? "";
    // Resolve app secret — the config stores it as SecretInput
    const appSecret =
      typeof this.params.msteamsConfig.appPassword === "string"
        ? this.params.msteamsConfig.appPassword
        : "";

    const result = await this.bridge.joinMeeting({
      callId,
      joinUrl: params.joinUrl,
      tenantId,
      appId,
      appSecret,
      receiveUnmixed: true,
    });

    if (!result.ok) {
      logger.error(`join failed: ${result.message}`);
      return result;
    }

    // Create session in joining state
    const route = resolveAgentRoute({
      cfg: this.params.cfg,
      channel: "msteams",
      accountId: this.params.accountId,
      peer: { kind: "channel", id: `voice:${callId}` },
    });

    const session: TeamsCallSession = {
      callId,
      graphCallId: result.graphCallId ?? "",
      joinUrl: params.joinUrl,
      state: "joining",
      complianceState: "awaiting",
      participants: new Map(),
      activeSpeakers: new Map(),
      route,
      playbackQueue: Promise.resolve(),
      createdAt: Date.now(),
      workerAddress: this.voiceConfig.workerAddress,
    };
    this.sessions.set(callId, session);

    // Subscribe to events and audio from the worker
    this.subscribeToEvents(callId);
    this.subscribeToAudio(callId);

    logger.info(`session created: callId=${callId} graphCallId=${result.graphCallId}`);
    return { ok: true, message: "Joining meeting", callId };
  }

  /** Leave / hang up a call. */
  async leave(params: { callId: string }): Promise<VoiceOperationResult> {
    const session = this.sessions.get(params.callId);
    if (!session) {
      return { ok: false, message: `No active session for callId=${params.callId}` };
    }

    logVoice(`leaving call: ${params.callId}`);
    session.state = "terminating";

    const result = await this.bridge.leaveCall(params.callId);
    this.cleanupSession(params.callId);
    return result;
  }

  /** Auto-join configured meetings on startup. */
  async autoJoin(): Promise<void> {
    if (this.capabilityTier !== "live_voice") {
      logVoice("skipping auto-join: not in live_voice mode");
      return;
    }

    for (const entry of this.voiceConfig.autoJoin) {
      try {
        const result = await this.joinMeeting({ joinUrl: entry.joinUrl });
        if (!result.ok) {
          logger.warn(`auto-join failed for ${entry.joinUrl}: ${result.message}`);
        }
      } catch (err) {
        logger.error(`auto-join error for ${entry.joinUrl}: ${formatErrorMessage(err)}`);
      }
    }
  }

  /** Destroy all sessions and disconnect. */
  async destroy(): Promise<void> {
    logVoice("destroying all sessions");

    const callIds = [...this.sessions.keys()];
    for (const callId of callIds) {
      try {
        await this.bridge.leaveCall(callId);
      } catch (err) {
        logVoice(`leave error during destroy: ${formatErrorMessage(err)}`);
      }
      this.cleanupSession(callId);
    }

    this.complianceGate.clear();
    await this.bridge.disconnect();
  }

  /** Status of all active sessions. */
  status(): VoiceOperationResult[] {
    return [...this.sessions.values()].map((s) => ({
      ok: s.state === "established",
      message: `callId=${s.callId} state=${s.state} compliance=${s.complianceState} participants=${s.participants.size}`,
      callId: s.callId,
    }));
  }

  // ── Event handling ────────────────────────────────────────────────────

  private subscribeToEvents(callId: string): void {
    const cancel = this.bridge.subscribeEvents(callId, (event) => {
      void this.handleCallEvent(callId, event).catch((err) => {
        logger.warn(`event handler error: ${formatErrorMessage(err)}`);
      });
    });
    this.eventSubscriptionCancellers.set(callId, cancel);
  }

  private async handleCallEvent(callId: string, event: CallEvent): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session) return;

    switch (event.type) {
      case "compliance":
        this.complianceGate.handleComplianceEvent(callId, event.status);
        session.complianceState = event.status;
        if (event.status === "active") {
          logger.info(`compliance active for call ${callId} — audio processing unlocked`);
        } else if (event.status === "denied") {
          logger.error(
            `compliance denied for call ${callId} — audio processing blocked. ` +
              "Ensure Teams policy-based recording is configured.",
          );
        }
        break;

      case "state":
        if (event.state === "established") {
          session.state = "established";
          session.establishedAt = Date.now();
          // Transition to awaiting_compliance (compliance gate still pending)
          if (session.complianceState === "awaiting") {
            session.state = "awaiting_compliance";
          }
          logger.info(`call ${callId} established`);
        } else if (event.state === "terminated") {
          session.state = "terminated";
          logger.info(`call ${callId} terminated: ${event.reason ?? "unknown"}`);
          this.cleanupSession(callId);
        }
        break;

      case "participant":
        this.handleParticipantEvent(session, event);
        break;

      case "qoe":
        logVoice(
          `QoE call=${callId} speaker=${event.speakerId} loss=${event.packetLoss} jitter=${event.jitterMs}ms`,
        );
        break;

      case "error":
        if (event.recoverable) {
          logger.warn(
            `recoverable error on call ${callId}: ${event.message} (worker will auto-rejoin)`,
          );
        } else {
          logger.error(`fatal error on call ${callId}: ${event.message}`);
          this.cleanupSession(callId);
        }
        break;
    }
  }

  private handleParticipantEvent(
    session: TeamsCallSession,
    event: Extract<CallEvent, { type: "participant" }>,
  ): void {
    switch (event.action) {
      case "joined": {
        const participant: TeamsParticipant = {
          aadUserId: event.aadUserId,
          displayName: event.displayName,
          isMuted: false,
          isInLobby: false,
        };
        session.participants.set(event.aadUserId, participant);
        logVoice(`participant joined: ${event.displayName ?? event.aadUserId}`);
        break;
      }
      case "left":
        session.participants.delete(event.aadUserId);
        logVoice(`participant left: ${event.displayName ?? event.aadUserId}`);
        break;
      case "muted": {
        const p = session.participants.get(event.aadUserId);
        if (p) p.isMuted = true;
        break;
      }
      case "unmuted": {
        const p = session.participants.get(event.aadUserId);
        if (p) p.isMuted = false;
        break;
      }
    }
  }

  // ── Audio processing ──────────────────────────────────────────────────

  private subscribeToAudio(callId: string): void {
    const cancel = this.bridge.subscribeUnmixedAudio(callId, (segment) => {
      void this.processAudioSegment(callId, segment).catch((err) => {
        logger.warn(`audio processing error: ${formatErrorMessage(err)}`);
      });
    });
    this.audioSubscriptionCancellers.set(callId, cancel);
  }

  private async processAudioSegment(callId: string, segment: UnmixedAudioSegment): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session) return;

    // Hard compliance gate — no audio processing before compliance is confirmed
    if (!this.complianceGate.isCompliant(callId)) {
      logVoice(`discarding audio segment: compliance not active for call ${callId}`);
      return;
    }

    // Duration check — skip segments shorter than minimum
    const durationSec = segment.durationMs / 1_000;
    if (durationSec < this.voiceConfig.minSegmentSeconds) {
      logVoice(
        `skipping short segment: ${durationSec.toFixed(2)}s < ${this.voiceConfig.minSegmentSeconds}s`,
      );
      return;
    }

    // Update speaker mapping
    if (segment.aadUserId) {
      session.activeSpeakers.set(segment.speakerId, segment.aadUserId);
    }

    // Build WAV from PCM
    const wavBuffer = buildWavBuffer(segment.pcmData, SAMPLE_RATE, CHANNELS, BIT_DEPTH);

    // Write temp file
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const tmpDir = resolvePreferredOpenClawTmpDir();
    const wavPath = path.join(tmpDir, `msteams-voice-${callId}-${Date.now()}.wav`);
    await fs.writeFile(wavPath, wavBuffer);

    // Schedule cleanup (30 minutes)
    setTimeout(() => {
      void fs.unlink(wavPath).catch(() => {});
    }, 30 * 60_000);

    // Transcribe (same pattern as Discord: extensions/discord/src/voice/manager.ts:226)
    const agentDir = resolveAgentDir(this.params.cfg, session.route.agentId);
    const transcriptionResult = await transcribeAudioFile({
      filePath: wavPath,
      cfg: this.params.cfg,
      agentDir,
      mime: "audio/wav",
    });
    const transcript = transcriptionResult.text?.trim();

    if (!transcript) {
      logVoice("empty transcript — skipping agent command");
      return;
    }

    // Build speaker label
    const speakerLabel = segment.displayName ?? segment.aadUserId ?? `speaker-${segment.speakerId}`;
    const prompt = speakerLabel ? `${speakerLabel}: ${transcript}` : transcript;

    logVoice(`transcript [${speakerLabel}]: ${transcript}`);

    // Send to agent pipeline (same pattern as Discord: manager.ts:617)
    const result = await agentCommandFromIngress(
      {
        message: prompt,
        sessionKey: session.route.sessionKey,
        agentId: session.route.agentId,
        messageChannel: "msteams",
        senderIsOwner: false,
        allowModelOverride: false,
        deliver: false,
      },
      this.params.runtime,
    );

    // Extract reply text (same pattern as Discord: manager.ts:630)
    const replyText = (result.payloads ?? [])
      .map((payload) => payload.text)
      .filter((text): text is string => typeof text === "string" && text.trim() !== "")
      .join("\n")
      .trim();

    if (replyText) {
      await this.speakToCall(session, replyText);
    }
  }

  private async speakToCall(session: TeamsCallSession, text: string): Promise<void> {
    // Queue playback to ensure ordered TTS output
    session.playbackQueue = session.playbackQueue.then(async () => {
      try {
        // Resolve TTS config (same pattern as Discord: manager.ts:646)
        const ttsConfig = resolveTtsConfig(this.params.cfg);
        const directive = parseTtsDirectives(text, ttsConfig.modelOverrides, {
          cfg: this.params.cfg,
          providerConfigs: ttsConfig.providerConfigs,
        });
        const speakText = directive.overrides.ttsText ?? directive.cleanedText.trim();
        if (!speakText) {
          logVoice("TTS skipped (empty after directive parsing)");
          return;
        }

        const ttsResult = await textToSpeech({
          text: speakText,
          cfg: this.params.cfg,
          channel: "msteams",
          overrides: directive.overrides,
        });

        if (!ttsResult.success || !ttsResult.audioPath) {
          logger.warn(`TTS failed: ${ttsResult.error ?? "unknown error"}`);
          return;
        }

        // Read TTS output and stream to worker
        const fs = await import("node:fs/promises");
        const audioData = await fs.readFile(ttsResult.audioPath);

        // Send as a single chunk — the worker handles buffering for IAudioSocket
        await this.bridge.playAudio(session.callId, [new Uint8Array(audioData)]);

        logVoice(`TTS playback sent for call ${session.callId} (${audioData.length} bytes)`);
      } catch (err) {
        logger.warn(`TTS playback error: ${formatErrorMessage(err)}`);
      }
    });

    await session.playbackQueue;
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  private cleanupSession(callId: string): void {
    const audioCancel = this.audioSubscriptionCancellers.get(callId);
    if (audioCancel) {
      audioCancel();
      this.audioSubscriptionCancellers.delete(callId);
    }

    const eventCancel = this.eventSubscriptionCancellers.get(callId);
    if (eventCancel) {
      eventCancel();
      this.eventSubscriptionCancellers.delete(callId);
    }

    this.complianceGate.remove(callId);
    this.sessions.delete(callId);

    logVoice(`session cleaned up: ${callId}`);
  }
}

// ---------------------------------------------------------------------------
// WAV buffer builder (same pattern as Discord voice manager)
// ---------------------------------------------------------------------------

function buildWavBuffer(
  pcm: Uint8Array,
  sampleRate: number,
  channels: number,
  bitDepth: number,
): Uint8Array {
  const bytesPerSample = (bitDepth / 8) * channels;
  const dataLength = pcm.length;
  const headerLength = 44;
  const totalLength = headerLength + dataLength;

  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, totalLength - 8, true);
  writeString(view, 8, "WAVE");

  // fmt sub-chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // sub-chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, bitDepth, true);

  // data sub-chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  // Copy PCM data
  const output = new Uint8Array(buffer);
  output.set(pcm, headerLength);

  return output;
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
