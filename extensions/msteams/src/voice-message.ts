// Msteams plugin module: voice messages in chat (#13).
//
// Teams delivers a voice clip as an audio attachment. When enabled, the chat handler transcribes
// each audio attachment and folds the transcript into the message text so the agent reads what was
// said instead of an opaque "<media:document>" placeholder. This file holds the pure, testable
// detection + text-merge logic; the wiring (download → transcribeAudioFile → merge) lives in
// monitor-handler/message-handler.ts.

/** True when an attachment's content type is an audio clip (a voice message). */
export function isAudioAttachment(contentType: string | undefined): boolean {
  return typeof contentType === "string" && contentType.toLowerCase().startsWith("audio/");
}

export interface VoiceTranscript {
  /** The transcribed text (empty string when transcription failed — skipped). */
  transcript: string;
  /** The placeholder this audio attachment contributed to the message text (e.g. "<media:document>"). */
  placeholder: string;
}

/**
 * Fold transcribed voice messages into the agent's message text. Each audio attachment's
 * placeholder is removed once and the transcripts are collectively prepended as a quoted block, so
 * the agent reads what was said instead of an opaque placeholder. Non-audio text/placeholders are
 * preserved. Returns rawBody unchanged when no transcript is usable.
 */
export function applyVoiceTranscripts(rawBody: string, items: VoiceTranscript[]): string {
  const usable = items.map((it) => it.transcript.trim()).filter((t) => t.length > 0);
  if (usable.length === 0) {
    return rawBody;
  }
  // Drop one placeholder occurrence per audio attachment, leaving any real text behind.
  let remaining = rawBody;
  for (const it of items) {
    const idx = remaining.indexOf(it.placeholder);
    if (idx >= 0) {
      remaining = remaining.slice(0, idx) + remaining.slice(idx + it.placeholder.length);
    }
  }
  remaining = remaining.replace(/\s+/g, " ").trim();

  const block = usable.map((t) => `🎙️ Voice message: "${t}"`).join("\n");
  return remaining ? `${block}\n\n${remaining}` : block;
}
