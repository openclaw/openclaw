import { isVoiceMessageCompatibleAudio } from "openclaw/plugin-sdk/media-runtime";

export function resolveTelegramVoiceSend(opts: {
  wantsVoice: boolean;
  contentType?: string | null;
  fileName?: string | null;
  logFallback?: (message: string) => void;
}): { useVoice: boolean } {
  if (!opts.wantsVoice) {
    return { useVoice: false };
  }
  if (isVoiceMessageCompatibleAudio(opts)) {
    return { useVoice: true };
  }
  opts.logFallback?.(
    `Telegram voice requested but media is ${opts.contentType ?? "unknown"} (${opts.fileName ?? "unknown"}); sending as audio file instead.`,
  );
  return { useVoice: false };
}
