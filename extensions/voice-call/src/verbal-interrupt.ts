/**
 * Deterministic verbal interrupts ("stop", "hold on", "never mind"): explicit phrases that must cut
 * the assistant off immediately, handled in code rather than by the model — the model is mid-
 * generation when these arrive, so deterministic handling is what makes the cut feel instant.
 * Whole-utterance matching only (after stripping filler), so "stop by the store" never triggers.
 */

/** Normalized utterances that mean "stop talking / hold on". */
const INTERRUPT_PHRASES = new Set([
  "stop",
  "stop it",
  "stop talking",
  "wait",
  "wait wait",
  "wait a second",
  "wait a minute",
  "hold on",
  "hang on",
  "never mind",
  "nevermind",
  "be quiet",
  "quiet",
  "shut up",
  "enough",
  "thats enough",
  "pause",
  "one second",
  "one sec",
  "give me a second",
]);

/** Leading/trailing filler tokens stripped before matching ("ok stop", "no wait", "stop please"). */
const FILLER_TOKENS = new Set(["ok", "okay", "oh", "no", "hey", "please", "now"]);

/**
 * True when the utterance — as a WHOLE — is a verbal interrupt. Deterministic and conservative:
 * lowercase, punctuation stripped, surrounding filler tokens removed, then an exact phrase-set
 * match capped at 4 words. Longer sentences that merely contain "stop"/"wait" do not match.
 */
export function isVerbalInterrupt(text: string | undefined): boolean {
  const words = (text ?? "")
    .toLowerCase()
    .replace(/['’]/g, "") // "that's" -> "thats", not "that s"
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  let start = 0;
  let end = words.length;
  while (start < end && FILLER_TOKENS.has(words[start] ?? "")) {
    start += 1;
  }
  while (end > start && FILLER_TOKENS.has(words[end - 1] ?? "")) {
    end -= 1;
  }
  const core = words.slice(start, end);
  if (core.length === 0 || core.length > 4) {
    return false;
  }
  return INTERRUPT_PHRASES.has(core.join(" "));
}
