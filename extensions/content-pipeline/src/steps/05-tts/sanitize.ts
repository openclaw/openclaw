/**
 * Pure text preprocessing for TTS.
 *
 * Deep-dive speaker notes (Step 4) are 4–6 sentences and can contain URLs,
 * markdown leaks, parenthetical source citations, and emoji that sound weird
 * or crash TTS engines when read aloud. These helpers clean the text up and
 * split it into sentence-sized chunks.
 *
 * Both functions are pure (no IO) so they're trivial to unit test.
 */

/** Whitelist patterns for parenthetical source citations we want to drop. */
const SOURCE_CITATION_PATTERNS: RegExp[] = [
  /\(according to [^)]*\)/gi,
  /\(source: [^)]*\)/gi,
  /\(source [^)]*\)/gi,
  /\(per [^)]*\)/gi,
  /\(via [^)]*\)/gi,
  /\[\d+\]/g, // [1], [2], etc.
];

/** Abbreviations we don't want sentence-split inside. */
const NON_SPLIT_ABBREVS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "vs",
  "etc",
  "inc",
  "ltd",
  "co",
  "u.s",
  "u.k",
  "e.g",
  "i.e",
]);

/**
 * Clean speaker notes for TTS consumption.
 *
 * Strips URLs, markdown leaks, parenthetical source citations, emoji, and
 * collapses whitespace. If the cleanup produces an empty string, returns the
 * original text so TTS still gets *something*.
 */
export function sanitizeForTts(text: string): string {
  if (!text) return text;
  let out = text;

  // 1. Strip URLs
  out = out.replace(/https?:\/\/\S+/gi, " ");

  // 2. Strip markdown
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1"); // bold
  out = out.replace(/\*([^*]+)\*/g, "$1"); // italic
  out = out.replace(/`([^`]+)`/g, "$1"); // code
  out = out.replace(/^#+\s+/gm, ""); // headers
  out = out.replace(/[_~]/g, ""); // stray underscores/tildes

  // 3. Strip source-citation parentheticals
  for (const pat of SOURCE_CITATION_PATTERNS) {
    out = out.replace(pat, " ");
  }

  // 4. Strip emoji (BMP symbols + emoticons range)
  out = out.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ");

  // 5. Collapse whitespace, trim
  out = out.replace(/\s+/g, " ").trim();

  // 6. If we stripped everything, return the original
  return out.length > 0 ? out : text;
}

/**
 * Protect abbreviation periods so they don't trigger sentence splitting.
 * Replaces "Dr." with "Dr\x01", "U.S." with "U\x01S\x01", etc.
 */
function protectAbbreviations(text: string): string {
  let out = text;
  for (const abbr of NON_SPLIT_ABBREVS) {
    // Match the abbreviation followed by a period (case-insensitive)
    const pattern = new RegExp(`\\b${abbr.replace(/\./g, "\\.")}\\.`, "gi");
    out = out.replace(pattern, (m) => m.replace(/\./g, "\x01"));
  }
  // Protect decimals like "3.5" — digit.digit stays glued
  out = out.replace(/(\d)\.(\d)/g, "$1\x01$2");
  return out;
}

function unprotectAbbreviations(text: string): string {
  return text.replace(/\x01/g, ".");
}

/**
 * Split text into sentence-sized chunks for TTS.
 *
 * Greedy-fills chunks up to `maxChars` (default 280) so we get roughly one
 * sentence or two short sentences per chunk. Long sentences that exceed
 * `maxChars` are emitted as-is (mid-sentence cuts sound bad). Empty input
 * returns an empty array.
 */
export function splitSentences(text: string, maxChars = 280): string[] {
  if (!text || !text.trim()) return [];

  const protectedText = protectAbbreviations(text);

  // Split on . ! ? followed by whitespace and a capital/quote start
  const raw = protectedText
    .split(/(?<=[.!?])\s+(?=["'A-Z])/)
    .map((s) => unprotectAbbreviations(s).trim())
    .filter(Boolean);

  if (raw.length === 0) return [];

  // Greedy fill
  const chunks: string[] = [];
  let current = "";

  for (const sentence of raw) {
    if (!current) {
      current = sentence;
      continue;
    }
    // Can we fit this sentence into the current chunk?
    if (current.length + 1 + sentence.length <= maxChars) {
      current = `${current} ${sentence}`;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}
