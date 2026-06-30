const DISCORD_VOICE_LOG_PREVIEW_CHARS = 500;

export function formatVoiceLogPreview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= DISCORD_VOICE_LOG_PREVIEW_CHARS) {
    return oneLine;
  }
  return `${oneLine.slice(0, DISCORD_VOICE_LOG_PREVIEW_CHARS)}...`;
}
