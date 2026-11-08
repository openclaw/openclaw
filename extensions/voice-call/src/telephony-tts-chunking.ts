// Voice Call plugin module splits long telephony replies for reliable synthesis.
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";

/**
 * Upper bound on the characters handed to one telephony synthesis request.
 *
 * A bounded internal of the stream synthesis path rather than a setting: the
 * limit exists to keep one request inside the provider synthesis timeout, which
 * is not a property an operator is positioned to tune per call.
 */
export const MAX_TELEPHONY_TTS_SYNTH_CHARS = 320;

/**
 * One sentence: a run of non-terminator characters plus its terminal
 * punctuation and trailing whitespace, or a trailing run with no terminator.
 *
 * The leading run is `*`, not `+`: punctuation that opens the text has no
 * preceding non-terminator character, so a `+` there left that span unmatched
 * and `String.match` dropped it — ".NET" was spoken as "NET", and a leading
 * ellipsis or question mark vanished.
 */
const TELEPHONY_SENTENCE_PATTERN = /[^.!?。！？]*[.!?。！？]+\s*|[^.!?。！？]+$/g;

/** Any character that is neither sentence-terminating punctuation nor whitespace. */
const SPEECH_CHARACTER = /[^.!?。！？\s]/;

/**
 * Split `clean` into sentence pieces whose concatenation is exactly `clean`.
 *
 * A piece holding only punctuation and whitespace is folded into the piece that
 * follows it (or into the preceding one at end of text), so a leading `.` stays
 * attached to the word it belongs to and no piece is punctuation alone.
 */
function splitSentencesLossless(clean: string): string[] {
  const pieces: string[] = [];
  let pending = "";
  for (const piece of clean.match(TELEPHONY_SENTENCE_PATTERN) ?? [clean]) {
    if (SPEECH_CHARACTER.test(piece)) {
      pieces.push(pending + piece);
      pending = "";
    } else {
      pending += piece;
    }
  }
  if (pending) {
    const last = pieces.pop();
    pieces.push(last === undefined ? pending : last + pending);
  }
  return pieces;
}

/**
 * Split a telephony reply into pieces no longer than `limit` characters,
 * preferring natural speech boundaries.
 *
 * A long reply synthesized as one request can exceed the provider synthesis
 * timeout and be dropped, leaving the caller in silence. Splitting keeps each
 * piece within the budget so it synthesizes and streams reliably; pieces are
 * played back-to-back.
 *
 * Boundary priority:
 * 1. Sentence-ending punctuation (`. ! ?` and CJK `。！？`) — each piece begins
 *    and ends on a natural pause, so the small per-piece prosody reset lands
 *    where a speaker would already pause.
 * 2. Consecutive short sentences are packed together up to `limit` to minimize
 *    the number of synthesis requests (fewer boundaries means smoother speech).
 * 3. A single sentence longer than `limit` falls back to the shared
 *    hard-bounded splitter, which breaks on whitespace and hard-cuts an
 *    unbroken token (for example a long URL) so every returned piece is
 *    `<= limit`.
 *
 * Segmentation is lossless: every character of the trimmed reply lands in
 * exactly one piece, in order. The only normalization is whitespace at a piece
 * boundary, which is trimmed away.
 *
 * Text at or under `limit` is returned unchanged as a single piece.
 */
export function chunkTelephonyReply(text: string, limit: number): string[] {
  const clean = (text ?? "").trim();
  if (!clean) {
    return [];
  }
  if (clean.length <= limit) {
    return [clean];
  }

  const sentences = splitSentencesLossless(clean);
  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    const trimmed = buf.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
    buf = "";
  };

  for (const sentence of sentences) {
    if (sentence.length > limit) {
      // A single over-long sentence: emit what is buffered, then hard-bound it.
      flush();
      for (const piece of chunkTextForOutbound(sentence.trim(), limit)) {
        chunks.push(piece);
      }
    } else if ((buf + sentence).length > limit) {
      // Adding this sentence would overflow: close the current piece first.
      flush();
      buf = sentence;
    } else {
      buf += sentence;
    }
  }
  flush();

  return chunks.length ? chunks : [clean];
}
