import { isVoiceMessageCompatibleAudio } from "openclaw/plugin-sdk/media-runtime";

export function resolveTelegramVoiceSend(opts: {
  wantsVoice: boolean;
  contentType?: string | null;
  fileName?: string | null;
  logFallback?: (message: string) => void;
}): { useVoice: boolean } {
  const useVoice = opts.wantsVoice && isVoiceMessageCompatibleAudio(opts);
  if (opts.wantsVoice && !useVoice) {
    opts.logFallback?.(
      `Telegram voice requested but media is ${opts.contentType ?? "unknown"} (${opts.fileName ?? "unknown"}); sending as audio file instead.`,
    );
  }
  return { useVoice };
}
