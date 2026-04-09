/**
 * Audio pipeline orchestrator for Teams live voice.
 *
 * Coordinates the full cycle:
 *   unmixed PCM segment → WAV → Whisper transcription → agent → TTS → worker
 *
 * Each segment is processed in the order received per speaker. The pipeline
 * enforces the compliance gate and minimum duration before processing.
 */

import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { resolveAgentDir, resolveTtsConfig } from "openclaw/plugin-sdk/agent-runtime";
import { agentCommandFromIngress } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/infra-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";
import { transcribeAudioFile } from "openclaw/plugin-sdk/media-understanding-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { parseTtsDirectives } from "openclaw/plugin-sdk/speech";
import { textToSpeech } from "openclaw/plugin-sdk/speech-runtime";
import type { ComplianceGate } from "./compliance-gate.js";
import type { ResolvedTeamsVoiceConfig } from "./config.js";
import type { CutThroughTTS } from "./cut-through-tts.js";
import type { StreamingSTTManager } from "./streaming-stt.js";
import type { TeamsCallSession, UnmixedAudioSegment } from "./types.js";
import type { WorkerBridge } from "./worker-bridge.js";

const logger = createSubsystemLogger("msteams/voice/pipeline");

const logPipeline = (message: string) => {
  logVerbose(`msteams voice/pipeline: ${message}`);
};

// Audio constants (matching .NET worker output)
const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BIT_DEPTH = 16;

// Cleanup delay for temp WAV files
const TEMP_FILE_CLEANUP_MS = 30 * 60_000;

export class AudioPipeline {
  constructor(
    private cfg: OpenClawConfig,
    private runtime: RuntimeEnv,
    private voiceConfig: ResolvedTeamsVoiceConfig,
    private complianceGate: ComplianceGate,
    private sttManager: StreamingSTTManager,
    private tts: CutThroughTTS,
    private bridge: WorkerBridge,
  ) {}

  /**
   * Process an unmixed audio segment through the full pipeline.
   *
   * Guards: compliance must be active, duration must meet minimum.
   */
  async processSegment(session: TeamsCallSession, segment: UnmixedAudioSegment): Promise<void> {
    // Compliance gate
    if (!this.complianceGate.isCompliant(session.callId)) {
      logPipeline(`discarding audio: compliance not active for ${session.callId}`);
      return;
    }

    // Duration gate
    const durationSec = segment.durationMs / 1_000;
    if (durationSec < this.voiceConfig.minSegmentSeconds) {
      logPipeline(
        `skipping short segment: ${durationSec.toFixed(2)}s < ${this.voiceConfig.minSegmentSeconds}s`,
      );
      return;
    }

    // Own-voice suppression via STT manager
    const sttSession = this.sttManager.getOrCreateSession(segment);
    if (!sttSession) {
      logPipeline(`suppressing own-voice for speaker ${segment.speakerId}`);
      return;
    }

    // Build WAV and write temp file
    const wavBuffer = buildWavBuffer(segment.pcmData, SAMPLE_RATE, CHANNELS, BIT_DEPTH);
    const tmpDir = resolvePreferredOpenClawTmpDir();
    const wavPath = join(
      tmpDir,
      `msteams-voice-${session.callId}-${segment.speakerId}-${Date.now()}.wav`,
    );
    await writeFile(wavPath, wavBuffer);
    setTimeout(() => void unlink(wavPath).catch(() => {}), TEMP_FILE_CLEANUP_MS);

    // Transcribe
    const agentDir = resolveAgentDir(this.cfg, session.route.agentId);
    const transcriptionResult = await transcribeAudioFile({
      filePath: wavPath,
      cfg: this.cfg,
      agentDir,
      mime: "audio/wav",
    });
    const transcript = transcriptionResult.text?.trim();

    if (!transcript) {
      logPipeline("empty transcript — skipping");
      return;
    }

    // Emit final transcript through STT session
    sttSession.emitFinalTranscript(transcript);

    // Build prompt with speaker attribution
    const speakerLabel = segment.displayName ?? segment.aadUserId ?? `speaker-${segment.speakerId}`;
    const prompt = `${speakerLabel}: ${transcript}`;
    logPipeline(`[${speakerLabel}]: ${transcript}`);

    // Agent command
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
      this.runtime,
    );

    // Extract reply
    const replyText = (result.payloads ?? [])
      .map((payload) => payload.text)
      .filter((text): text is string => typeof text === "string" && text.trim() !== "")
      .join("\n")
      .trim();

    if (!replyText) return;

    // TTS and playback
    await this.speakReply(session, replyText);
  }

  private async speakReply(session: TeamsCallSession, text: string): Promise<void> {
    try {
      const ttsConfig = resolveTtsConfig(this.cfg);
      const directive = parseTtsDirectives(text, ttsConfig.modelOverrides, {
        cfg: this.cfg,
        providerConfigs: ttsConfig.providerConfigs,
      });
      const speakText = directive.overrides.ttsText ?? directive.cleanedText.trim();
      if (!speakText) return;

      const ttsResult = await textToSpeech({
        text: speakText,
        cfg: this.cfg,
        channel: "msteams",
        overrides: directive.overrides,
      });

      if (!ttsResult.success || !ttsResult.audioPath) {
        logger.warn(`TTS failed: ${ttsResult.error ?? "unknown"}`);
        return;
      }

      await this.tts.playAudioFile(session.callId, ttsResult.audioPath);
    } catch (err) {
      logger.warn(`speak error: ${formatErrorMessage(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// WAV buffer builder
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

  writeString(view, 0, "RIFF");
  view.setUint32(4, totalLength - 8, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  const output = new Uint8Array(buffer);
  output.set(pcm, headerLength);
  return output;
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
