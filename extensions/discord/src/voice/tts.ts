import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig, TtsConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getDiscordRuntime } from "../runtime.js";
import { sanitizeVoiceReplyTextForSpeech } from "./sanitize.js";

export async function transcribeVoiceAudio(params: {
  cfg: OpenClawConfig;
  agentId: string;
  filePath: string;
}) {
  const result = await getDiscordRuntime().mediaUnderstanding.transcribeAudioFile({
    filePath: params.filePath,
    cfg: params.cfg,
    agentDir: resolveAgentDir(params.cfg, params.agentId),
    mime: "audio/wav",
  });
  return {
    text: normalizeOptionalString(result.text),
    processing: result.decision?.attachmentProcessing?.[0],
    unavailable:
      result.decision?.outcome === "skipped" &&
      result.decision.attachmentDispositions?.[0]?.kind === "no-model" &&
      result.decision.attachmentProcessing?.[0] === "omitted" &&
      result.decision.attachments.length > 0 &&
      result.decision.attachments.every((attachment) => attachment.attempts.length === 0),
  };
}

export async function synthesizeVoiceReplyAudio(params: {
  cfg: OpenClawConfig;
  override?: TtsConfig;
  replyText: string;
  speakerLabel: string;
}) {
  const runtime = getDiscordRuntime();
  const prepared = await runtime.tts.prepareTtsRequest({
    cfg: params.cfg,
    override: params.override,
    text: params.replyText,
  });
  const directive = prepared.directives;
  const rawSpeakText = directive.overrides.ttsText ?? directive.cleanedText.trim();
  const speakText = sanitizeVoiceReplyTextForSpeech(rawSpeakText, params.speakerLabel);
  if (!speakText) {
    return { status: "empty" as const };
  }
  const request = {
    text: speakText,
    cfg: prepared.cfg,
    channel: "discord",
    overrides: directive.overrides,
  };
  const streamResult = await runtime.tts.textToSpeechStream?.({
    ...request,
    disableFallback: true,
  });
  if (streamResult?.success && streamResult.audioStream) {
    return {
      status: "ok" as const,
      mode: "stream" as const,
      audioStream: streamResult.audioStream,
      release: streamResult.release,
      speakText,
    };
  }
  const streamFailure =
    streamResult && !streamResult.success
      ? streamResult.attempts?.findLast((attempt) => attempt.outcome === "failed")
      : undefined;

  const result = await runtime.tts.textToSpeech(request);
  if (!result.success || !result.audioPath) {
    return { status: "failed" as const, error: result.error ?? "unknown error" };
  }
  return {
    status: "ok" as const,
    mode: "file" as const,
    audioPath: result.audioPath,
    speakText,
    ...(streamFailure
      ? {
          streamFailure: { provider: streamFailure.provider, reasonCode: streamFailure.reasonCode },
        }
      : {}),
  };
}
