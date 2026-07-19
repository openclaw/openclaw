// UTF-16 Boundary Demonstration for SSE Argument Chunking
// This demonstrates that the fix in openai-http.ts correctly handles
// surrogate pairs that cross the 256-code-unit chunk boundary.

// --- Reproduction of the fix logic (copied from packages/normalization-core/src/utf16-slice.ts) ---
function isHighSurrogate(codeUnit) {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}
function isLowSurrogate(codeUnit) {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function sliceUtf16Safe(input, start, end) {
  const len = input.length;
  let from = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
  let to = end === undefined ? len : end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
  if (to <= from) return "";
  if (from > 0 && from < len) {
    const codeUnit = input.charCodeAt(from);
    if (isLowSurrogate(codeUnit) && isHighSurrogate(input.charCodeAt(from - 1))) from += 1;
  }
  if (to > 0 && to < len) {
    const codeUnit = input.charCodeAt(to - 1);
    if (isHighSurrogate(codeUnit) && isLowSurrogate(input.charCodeAt(to))) to -= 1;
  }
  return input.slice(from, to);
}

// Fixed version (as in the PR)
function splitArgumentsFixed(argumentsValue) {
  const chunkSize = 256;
  const chunks = [];
  for (let i = 0; i < argumentsValue.length; ) {
    const chunk = sliceUtf16Safe(argumentsValue, i, i + chunkSize);
    chunks.push(chunk);
    i += chunk.length || 1;
  }
  return chunks.length > 0 ? chunks : [""];
}

// Old (broken) version for comparison
function splitArgumentsOld(argumentsValue) {
  const chunkSize = 256;
  const chunks = [];
  for (let i = 0; i < argumentsValue.length; i += chunkSize) {
    chunks.push(argumentsValue.slice(i, i + chunkSize));
  }
  return chunks.length > 0 ? chunks : [""];
}

// --- Test helpers ---
let passed = 0;
let failed = 0;
let results = [];

function test(name, fn) {
  try {
    fn();
    results.push(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    results.push(`  FAIL  ${name}  — ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || "assertion failed");
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg ? `${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}` : `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

// --- Build a test string with a surrogate pair exactly at the 256-code-unit boundary ---
// JSON: {"key":"AAAA...AAAA😀..."}
// The emoji 😀 (U+1F600) is encoded as surrogate pair 😀
// We want the high surrogate \uD83D at position 255 (0-indexed)

const emoji = "😀"; // 2 code units: \uD83D \uDE00

// Build padding so the emoji starts at position 255
// Prefix: {"key":"  (7 chars)
// Padding: positions 7-254 = 248 chars of 'A'
// Emoji starts at position 255
// Then some more content + closing quote + }

const prefix = '{"key":"';
const padding = "A".repeat(255 - prefix.length); // 248 As
const suffix = 'more","nested":{"value":42}}';    // remaining content

// Total: prefix(7) + padding(248) + emoji(2) + suffix(26) = 283
const testJson = prefix + padding + emoji + suffix;
const expectedJson = testJson; // reference

console.log("\n=== SSE Argument Chunking: UTF-16 Safety Evidence ===\n");

// Test 1: Verify surrogate pair is at the boundary
test("surrogate pair across 256-code-unit boundary", () => {
  // Verify the high surrogate lands at position 255
  const hiCode = testJson.charCodeAt(255);
  const loCode = testJson.charCodeAt(256);
  assert(isHighSurrogate(hiCode), `Expected high surrogate at pos 255, got 0x${hiCode.toString(16)}`);
  assert(isLowSurrogate(loCode), `Expected low surrogate at pos 256, got 0x${loCode.toString(16)}`);

  // Fixed version: should not split the pair
  const fixed = splitArgumentsFixed(testJson);
  const joined = fixed.join("");
  assertEqual(joined, expectedJson, "Fixed: concatenated chunks must equal original");

  // Old version: would split the pair — the high surrogate ends up alone
  const old = splitArgumentsOld(testJson);
  // old[0] ends with a dangling high surrogate (U+D83D)
  const lastChunkOld = old[old.length - 1];
  // It should still join back correctly at the JS level (string coalescing works),
  // but intermediate chunks would have invalid unicode
  assert(old.length > 0, "Old should produce at least one chunk");
});

// Test 2: Concatenated chunks form valid JSON
test("concatenated chunks parse as valid JSON", () => {
  const fixed = splitArgumentsFixed(testJson);
  const joined = fixed.join("");
  const parsed = JSON.parse(joined);
  assertEqual(parsed.key, padding + emoji + "more", "JSON key value must match original");
  assertEqual(parsed.nested.value, 42, "Nested object must be intact");
});

// Test 3: Multiple emoji across boundaries
test("multiple chunks with surrogate pairs", () => {
  // Build a string with emoji at the end of each chunk
  // chunk 0: 255 chars + high surrogate... oh wait, that won't work
  // Let's build a case where we have a surrogate pair within each chunk boundary
  const manyEmoji = prefix + padding + emoji + emoji + emoji + suffix;
  const fixed = splitArgumentsFixed(manyEmoji);
  const joined = fixed.join("");
  assertEqual(joined, manyEmoji, "Multiple emoji: concatenated chunks must equal original");
  const parsed = JSON.parse(joined);
  assertEqual(parsed.key, padding + emoji + emoji + emoji + "more");
});

// Test 4: Plain ASCII boundary - no surrogate pair
test("plain ASCII input", () => {
  const ascii = '{"a":"' + "x".repeat(500) + '"}';
  const fixed = splitArgumentsFixed(ascii);
  const joined = fixed.join("");
  assertEqual(joined, ascii, "ASCII chunks must reconstruct");
});

// Test 5: Empty string
test("empty string", () => {
  const fixed = splitArgumentsFixed("");
  assertEqual(fixed.length, 1, "Empty input returns [\"\"]");
  assertEqual(fixed[0], "", "Empty chunk");
});

// Test 6: Chunk boundary visualization
test("chunk boundary visualization", () => {
  const fixed = splitArgumentsFixed(testJson);
  const chunks = fixed.length;

  console.log(`    Input length: ${testJson.length} code units, chunks: ${chunks}`);
  for (let i = 0; i < chunks; i++) {
    const c = fixed[i];
    const safeStart = c.length > 0 && (c.charCodeAt(0) < 0xdc00 || c.charCodeAt(0) > 0xdfff);
    const safeEnd = c.length > 0 && (c.charCodeAt(c.length - 1) < 0xd800 || c.charCodeAt(c.length - 1) > 0xdbff);
    console.log(`    chunk[${i}] len=${c.length} ends=0x${c.charCodeAt(c.length - 1).toString(16)} starts=0x${c.charCodeAt(0).toString(16)} safe=${safeStart && safeEnd}`);
  }

  // Verify no dangling surrogates in any chunk
  for (let i = 0; i < fixed.length; i++) {
    const c = fixed[i];
    for (let j = 0; j < c.length; j++) {
      if (isHighSurrogate(c.charCodeAt(j))) {
        assert(j + 1 < c.length && isLowSurrogate(c.charCodeAt(j + 1)),
          `Found isolated high surrogate at chunk[${i}][${j}]`);
      }
    }
  }
});

// --- Summary ---
console.log(results.join("\n"));
console.log(`\n=== Results: ${passed} passed, ${failed} failed out of ${passed + failed} ===\n`);

process.exit(failed > 0 ? 1 : 0);
