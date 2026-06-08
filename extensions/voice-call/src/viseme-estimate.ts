/**
 * CVI Phase 5 (spike) — cheap text → approximate viseme timeline.
 *
 * Proves the speech.marks → worker lip-shape pipeline end-to-end with NO TTS-provider change: it maps
 * the assistant's reply text grapheme-by-grapheme to coarse Azure viseme ids (the Microsoft 0–21 set)
 * and spreads them evenly across the known synthesized-audio duration. Crude on purpose — the full pass
 * swaps this for real Azure `visemeReceived` events. The worker maps these ids to mouth shapes and
 * blends them over the RMS openness, so even rough timing reads as "the mouth changes shape per sound".
 */

export type VisemeMark = { tMs: number; visemeId: number };

/**
 * Coarse grapheme → Azure viseme id (the Microsoft viseme set, 0–21: 0 = silence, the rest are mouth
 * shapes grouped by phoneme — vowels, diphthongs, and consonant classes). Vowels carry the visible
 * shape; consonants approximate. The worker maps these ids to a small set of drawn mouth shapes.
 * Ref: Azure Speech "Viseme ID" table (mstts viseme events).
 */
const CHAR_VISEME: Readonly<Record<string, number>> = {
  a: 2, // ɑ (open)
  e: 4, // ɛ
  i: 6, // i (wide)
  o: 8, // o (round)
  u: 7, // u (round)
  y: 6,
  m: 21,
  b: 21,
  p: 21, // closed lips
  f: 18,
  v: 18, // lip-teeth
  w: 7,
  r: 13,
  l: 14,
  s: 15,
  z: 15,
  x: 15, // wide / teeth
  t: 19,
  d: 19,
  n: 19,
  k: 20,
  g: 20,
  c: 20,
  q: 20,
  h: 12,
  j: 16,
};

/**
 * Estimate a viseme timeline for `text` spoken over `durationMs`. Spaces become a closed/silence viseme
 * (0) between words; unmapped chars (digits, punctuation) are skipped. Consecutive identical visemes are
 * collapsed (one mark per change) to keep the payload small.
 */
export function estimateVisemes(text: string | null | undefined, durationMs: number): VisemeMark[] {
  const normalized = (text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized || durationMs <= 0) {
    return [];
  }
  const tokens: number[] = [];
  for (const ch of normalized) {
    if (ch === " ") {
      tokens.push(0); // silence/closed between words
      continue;
    }
    const v = CHAR_VISEME[ch];
    if (v !== undefined) {
      tokens.push(v);
    }
  }
  // All-silence (only spaces survived, e.g. digits/punctuation) carries no visible lip motion.
  if (!tokens.some((v) => v !== 0)) {
    return [];
  }
  const step = durationMs / tokens.length;
  const marks: VisemeMark[] = [];
  let last = -1;
  for (let i = 0; i < tokens.length; i++) {
    const v = tokens[i];
    if (v === last) {
      continue; // collapse runs — emit only on change
    }
    marks.push({ tMs: Math.round(i * step), visemeId: v });
    last = v;
  }
  return marks;
}

/** Map one grapheme to its viseme id (space → 0 silence; unmapped → undefined). Shared by both paths. */
function visemeForChar(ch: string): number | undefined {
  if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") {
    return 0;
  }
  return CHAR_VISEME[ch.toLowerCase()];
}

/**
 * Real-timing viseme marks from an ElevenLabs `/with-timestamps` character alignment (the full pass):
 * `characters[i]` is voiced starting at `startTimesSeconds[i]`, so each character's ACTUAL start time
 * becomes a mark instead of an even spread. Same char→viseme map as the estimator; consecutive identical
 * visemes are collapsed, unmapped chars skipped, and an all-silence result returns [].
 */
export function visemesFromAlignment(
  characters: readonly string[],
  startTimesSeconds: readonly number[],
): VisemeMark[] {
  const n = Math.min(characters.length, startTimesSeconds.length);
  const marks: VisemeMark[] = [];
  let last = -1;
  let sawVoiced = false;
  for (let i = 0; i < n; i++) {
    const v = visemeForChar(characters[i] ?? "");
    if (v === undefined) {
      continue; // punctuation / digit — no mark
    }
    if (v !== 0) {
      sawVoiced = true;
    }
    if (v === last) {
      continue; // collapse runs — emit only on change
    }
    marks.push({ tMs: Math.max(0, Math.round((startTimesSeconds[i] ?? 0) * 1000)), visemeId: v });
    last = v;
  }
  return sawVoiced ? marks : [];
}
