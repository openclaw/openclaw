import type { DiscordVoiceTranscriptCapture } from "./recording-types.js";
import type { VoiceSessionEntry } from "./session.js";

export type RecordingSource = Pick<VoiceSessionEntry, "guildId" | "channelId" | "voiceSessionKey">;

export function publishRecordingUtterance(
  capture: DiscordVoiceTranscriptCapture,
  { guildId, channelId, voiceSessionKey }: RecordingSource,
  speaker: { id: string; label: string },
  { text, startedAt }: { text: string; startedAt?: number },
) {
  return capture.onUtterance({
    sessionId: capture.sessionId,
    ...(startedAt !== undefined ? { startedAt: new Date(startedAt).toISOString() } : {}),
    final: true,
    speaker,
    text,
    metadata: { channel: "discord", guildId, channelId, voiceSessionKey },
  });
}
