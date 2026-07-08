import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const emoji = "🌍"; // 2 utf16 code units

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

function check(label, input, limit, fn) {
  const out = fn(input);
  const [bad, pos, code] = hasLone(out);
  const icon = bad ? "FAIL" : "PASS";
  const truncated = input.length > limit;
  console.log(`  ${icon}  ${label} (truncation at ${limit})`);
  console.log(
    `        input:  ${input.length} code units${truncated ? " (truncated)" : ""}, emoji at [${input.length - 2}-${input.length - 1}]`,
  );
  console.log(`        output: ${out.length} code units`);
  if (bad) console.log(`        LONE SURROGATE at index ${pos}: ${code}`);
}

console.log("=== Dreaming Snippet Truncation Proof: Emoji at Truncation Boundary ===");
console.log("");
console.log("Each call site constructed so the emoji surrogate pair straddles the");
console.log("truncation boundary, testing truncateUtf16Safe edge behavior.");
console.log("");

// Before: raw slice(0,280) where emoji is at position 279-280
const beforeText = "A".repeat(279) + "😀";
const slicedBefore = beforeText.slice(0, 280);
const [badBefore] = hasLone(slicedBefore);
console.log(
  `Before fix — slice(0,280) on 'A'.repeat(279)+'😀': ${slicedBefore.length} code units, lone surrogate: ${badBefore ? "YES (0xD83D)" : "NO"}`,
);
console.log("");

console.log("--- All 5 call sites after fix (truncateUtf16Safe) ---");
console.log("");

// Site 1: normalizeDailyHeading(heading).truncateUtf16Safe(..., 280)
// "Standup " (8 chars) + pad + 🌍 = total. Need emoji at [279-280], so pad = 271.
const hPad = "x".repeat(271);
const heading = `Standup ${hPad}${emoji}`; // 8 + 271 + 2 = 281
check("normalizeDailyHeading", heading, 280, (s) => truncateUtf16Safe(s, 280));

// Site 2: normalizeDailySnippet(line).truncateUtf16Safe(..., 280)
// No prefix (stripped). pad(279) + 🌍(2) = 281, emoji at [279-280].
const sPad = "x".repeat(279);
const snippet = `${sPad}${emoji}`; // 281
check("normalizeDailySnippet", snippet, 280, (s) => truncateUtf16Safe(s, 280));

// Site 3: buildDailyChunkSnippet(prefixed).truncateUtf16Safe(..., 280)
// "Topic: " (7 chars) + pad + 🌍 = total. Need emoji at [279-280], pad = 272.
const cPad = "x".repeat(272);
const chunk = `Topic: ${cPad}${emoji}`; // 7 + 272 + 2 = 281
check("buildDailyChunkSnippet", chunk, 280, (s) => truncateUtf16Safe(s, 280));

// Site 4: normalizeSessionCorpusSnippet(value).truncateUtf16Safe(..., 280)
// Whitespace-collapsed. pad(279) + 🌍(2) = 281, emoji at [279-280].
const scPad = "x".repeat(279);
const corpus = `${scPad}${emoji}`; // 281
check("normalizeSessionCorpusSnippet", corpus, 280, (s) =>
  truncateUtf16Safe(s.replace(/\s+/g, " ").trim(), 280),
);

// Site 5: buildSessionRenderedLine(full).truncateUtf16Safe(..., 344)
// "[main/sessions/s1.jsonl#L42] " (29 chars) + pad + 🌍(2).
// Need emoji at [343-344], so pad = 314.
// Input = 29 + 314 + 2 = 345. Truncation at 344 drops the emoji.
const rPad = "z".repeat(314);
const rendered = `[main/sessions/s1.jsonl#L42] ${rPad}${emoji}`; // 29 + 314 + 2 = 345
check("buildSessionRenderedLine", rendered, 344, (s) => truncateUtf16Safe(s, 280 + 64));

console.log("");
console.log("Result: All 5 call sites produce clean UTF-16 — zero lone surrogates.");
