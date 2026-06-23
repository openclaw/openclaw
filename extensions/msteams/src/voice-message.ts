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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Fold transcribed voice messages into the agent's message text. Each TRANSCRIBED attachment's
 * placeholder is consumed once and the transcripts are collectively prepended as a quoted block, so
 * the agent reads what was said instead of an opaque placeholder. A failed clip keeps its
 * placeholder (the agent should still see an opaque attachment remained), and a combined
 * "<media:document> (N files)" token is decremented per consumed clip rather than leaving a
 * dangling "(N files)" behind. Non-audio text/placeholders are preserved. Returns
 * rawBody unchanged when no transcript is usable.
 */
export function applyVoiceTranscripts(rawBody: string, items: VoiceTranscript[]): string {
  const usable = items.map((it) => it.transcript.trim()).filter((t) => t.length > 0);
  if (usable.length === 0) {
    return rawBody;
  }
  // Consume one placeholder occurrence per transcribed clip. The body may carry the per-item
  // placeholder N times, or one combined "<placeholder> (N files)" token covering N documents —
  // treat the counter as N occurrences and decrement it.
  let remaining = rawBody;
  for (const it of items) {
    if (!it.transcript.trim()) {
      continue; // failed clip: keep its placeholder in the body
    }
    const match = new RegExp(`${escapeRegExp(it.placeholder)}(?: \\((\\d+) files\\))?`).exec(
      remaining,
    );
    if (!match) {
      continue;
    }
    const count = match[1] ? Number(match[1]) : 1;
    const rest = count - 1;
    const replacement =
      rest <= 0 ? "" : rest === 1 ? it.placeholder : `${it.placeholder} (${rest} files)`;
    remaining =
      remaining.slice(0, match.index) +
      replacement +
      remaining.slice(match.index + match[0].length);
  }
  remaining = remaining.replace(/\s+/g, " ").trim();

  const block = usable.map((t) => `🎙️ Voice message: "${t}"`).join("\n");
  return remaining ? `${block}\n\n${remaining}` : block;
}
