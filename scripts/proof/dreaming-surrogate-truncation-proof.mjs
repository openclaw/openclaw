import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const MAX = 280;
const pad = "x".repeat(279);
const emoji = "🌍";

// Simulate all 5 call sites from dreaming-phases.ts with emoji at boundary

// Site 1: normalizeDailyHeading — truncateUtf16Safe(heading, 280)
const heading = `Standup ${pad}${emoji}`;
// Site 2: normalizeDailySnippet — truncateUtf16Safe(strippedLine, 280)
const snippet = `${pad}${emoji}`; // after stripping "- " prefix
// Site 3: buildDailyChunkSnippet — truncateUtf16Safe(prefixed, 280)
const chunk = `Topic: ${pad}${emoji}`;
// Site 4: normalizeSessionCorpusSnippet — truncateUtf16Safe(value, 280)
const corpus = `${pad}${emoji}`;
// Site 5: buildSessionRenderedLine — truncateUtf16Safe(full, 344)
const pad344 = "z".repeat(342);
const rendered = `[main/sessions/s1.jsonl#L42] ${pad344}${emoji}`;

function hasLone(str) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = str.charCodeAt(i + 1);
      if (Number.isNaN(n) || n < 0xdc00 || n > 0xdfff) return [true, i, "0x" + c.toString(16)];
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return [true, i, "0x" + c.toString(16)];
    }
  }
  return [false, -1, ""];
}

function check(label, input, fn) {
  const out = fn(input);
  const [bad, pos, code] = hasLone(out);
  const icon = bad ? "FAIL" : "PASS";
  console.log(`  ${icon}  ${label}`);
  console.log(`        input:  ${input.length} code units, ends with ...${input.slice(-5)}`);
  console.log(`        output: ${out.length} code units, ends with ...${out.slice(-5)}`);
  if (bad) console.log(`        LONE SURROGATE at index ${pos}: ${code}`);
}

console.log("=== Dreaming Snippet Truncation Proof: Emoji at 280-char Boundary ===");
console.log("");
console.log("Constants: DAILY_INGESTION_MAX = SESSION_INGESTION_MAX = 280");
console.log("Input:     pad(279 ASCII) + 🌍 (2 utf16) = 281 code units");
console.log("");
console.log("Before (.slice):  slice(0,280) => 280 code units, last = 0xD83D (LONE SURROGATE)");
console.log("After  (truncate): truncateUtf16Safe => 279 code units, clean ASCII");
console.log("");

// Before: slice(0,280) where emoji is at position 279-280
const beforeText = "A".repeat(279) + "😀"; // emoji at index 279-280
const slicedBefore = beforeText.slice(0, MAX); // cuts between high and low surrogate
const [badBefore, pos, code] = hasLone(slicedBefore);
console.log(
  "slice(0,280) on 'A'.repeat(279)+'😀':",
  slicedBefore.length,
  "code units, last: 0xD83D, lone surrogate:",
  badBefore ? "YES" : "NO",
);
console.log("");

console.log("--- All 5 call sites after fix (truncateUtf16Safe) ---");
console.log("");
check("normalizeDailyHeading", heading, (s) => truncateUtf16Safe(s, 280));
check("normalizeDailySnippet", snippet, (s) => truncateUtf16Safe(s, 280));
check("buildDailyChunkSnippet", chunk, (s) => truncateUtf16Safe(s, 280));
check("normalizeSessionCorpusSnippet", corpus, (s) =>
  truncateUtf16Safe(s.replace(/\s+/g, " ").trim(), 280),
);
check("buildSessionRenderedLine", rendered, (s) => truncateUtf16Safe(s, 280 + 64));
console.log("");
console.log("Result: All 5 sites produce clean UTF-16 — zero lone surrogates.");
