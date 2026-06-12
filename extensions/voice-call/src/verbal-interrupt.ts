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
  // Arabic (bilingual #19): the deterministic cut must work in both call languages — the model
  // mirrors Arabic, so the interrupt layer has to as well. Whole-utterance matching plus the
  // normalizer's tashkeel stripping keep these as conservative as the English set.
  "توقف", // stop
  "قف", // halt
  "اسكت", // be quiet
  "اصمت", // silence
  "انتظر", // wait
  "انتظر لحظة", // wait a moment
  "استنى", // wait (colloquial)
  "استنا",
  "لحظة", // one moment
  "لحظه",
  "لحظة واحدة", // just a moment
  "ثانية", // one second
  "ثانيه",
  "ثانية واحدة",
  "دقيقة", // one minute
  "دقيقه",
  "مهلا", // hold on
  "خلاص", // enough / that's it
  "كفى", // enough
  "كفاية",
  "كفايه",
  "بس", // enough/stop (colloquial; safe only because matching is whole-utterance)
]);

/**
 * Leading/trailing filler tokens stripped before matching ("ok stop", "no wait", "stop please";
 * Arabic: "طيب توقف" = "ok stop", "يا ⟨name⟩" = the vocative before a wake phrase).
 */
const FILLER_TOKENS = new Set(["ok", "okay", "oh", "no", "hey", "please", "now", "طيب", "لا", "يا"]);

function normalizeWords(text: string | undefined): string[] {
  return (
    (text ?? "")
      .toLowerCase()
      .replace(/['’]/g, "") // "that's" -> "thats", not "that s"
      // Combining marks (Arabic tashkeel, accents) and the Arabic tatweel attach INSIDE a word —
      // delete them outright so "تَوَقَّف" normalizes to "توقف" instead of splitting apart.
      .replace(/[\p{M}ـ]/gu, "")
      // Letters in ANY script survive (bilingual #19 — an Arabic "توقف" must cut as instantly as
      // "stop"; same \p{L} approach as group-call-gate.ts). Everything else separates words.
      .replace(/[^\p{L}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
}

function startsWithSeq(words: string[], seq: string[]): boolean {
  return seq.length > 0 && seq.length <= words.length && seq.every((w, i) => words[i] === w);
}

function endsWithSeq(words: string[], seq: string[]): boolean {
  const offset = words.length - seq.length;
  return seq.length > 0 && offset >= 0 && seq.every((w, i) => words[offset + i] === w);
}

/**
 * True when the utterance — as a WHOLE — is a verbal interrupt. Deterministic and conservative:
 * lowercase, punctuation stripped, surrounding filler tokens AND the configured wake phrases
 * removed ("hey ⟨name⟩, stop" must cut as instantly as a bare "stop" — addressing the bot by name
 * is how people interrupt it in meetings), then an exact phrase-set match capped at 4 words.
 * Longer sentences that merely contain "stop"/"wait" do not match.
 */
export function isVerbalInterrupt(text: string | undefined, wakePhrases?: string[]): boolean {
  let core = normalizeWords(text);
  const wake = (wakePhrases ?? []).map(normalizeWords).filter((seq) => seq.length > 0);
  // Strip surrounding filler/wake tokens until stable — they interleave ("ok ⟨name⟩ please stop").
  let changed = true;
  while (changed && core.length > 0) {
    changed = false;
    while (core.length > 0 && FILLER_TOKENS.has(core[0] ?? "")) {
      core.shift();
      changed = true;
    }
    while (core.length > 0 && FILLER_TOKENS.has(core[core.length - 1] ?? "")) {
      core.pop();
      changed = true;
    }
    for (const seq of wake) {
      if (startsWithSeq(core, seq)) {
        core = core.slice(seq.length);
        changed = true;
      } else if (endsWithSeq(core, seq)) {
        core = core.slice(0, core.length - seq.length);
        changed = true;
      }
    }
  }
  // The wake word alone ("⟨name⟩?") is an address, not an interrupt.
  if (core.length === 0 || core.length > 4) {
    return false;
  }
  return INTERRUPT_PHRASES.has(core.join(" "));
}
