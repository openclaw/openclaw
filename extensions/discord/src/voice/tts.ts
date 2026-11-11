import type { OpenClawConfig, TtsConfig } from "openclaw/plugin-sdk/config-contracts";
import { stripInlineDirectiveTagsForDisplay } from "openclaw/plugin-sdk/text-chunking";
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
import { getDiscordRuntime } from "../runtime.js";

const SPEECH_EMOJI_RE =
  /(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D|\p{Extended_Pictographic}|\p{Emoji_Modifier})*)+/gu;

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
  let cleaned = stripInlineDirectiveTagsForDisplay(rawSpeakText).text.trim();
  if (!cleaned) {
    return { status: "empty" as const };
  }

  const label = params.speakerLabel?.trim();
  if (label) {
    const prefix = new RegExp(`^${escapeRegExp(label)}\\s*:\\s*`, "i");
    cleaned = cleaned.replace(prefix, "").trim();
  }

  const speakText = cleaned
    .replace(SPEECH_EMOJI_RE, " ")
    .replace(/\s+([?!.,:;])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
  if (!speakText) {
    return { status: "empty" as const };
  }
  const request = {
    text: speakText,
    cfg: prepared.cfg,
    channel: "discord",
    overrides: directive.overrides,
  };
  const streamResult = await runtime.tts.textToSpeechStream({
    ...request,
    disableFallback: true,
  });
  if (streamResult.success && streamResult.audioStream) {
    return {
      status: "ok" as const,
      mode: "stream" as const,
      audioStream: streamResult.audioStream,
      release: streamResult.release,
    };
  }
  const streamFailure = !streamResult.success
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
    ...(streamFailure
      ? {
          streamFailure: { provider: streamFailure.provider, reasonCode: streamFailure.reasonCode },
        }
      : {}),
  };
}
