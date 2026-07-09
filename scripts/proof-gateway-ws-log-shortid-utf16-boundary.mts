// Proof: shortId's legacy raw slices split surrogate pairs at the edges;
// sliceUtf16Safe keeps both edges valid UTF-16.

import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

function legacyShortId(value: string): string {
  const s = value.trim();
  if (s.length <= 24) {
    return s;
  }
  return `${s.slice(0, 12)}…${s.slice(-4)}`;
}

function fixedShortId(value: string): string {
  const s = value.trim();
  if (s.length <= 24) {
    return s;
  }
  return `${sliceUtf16Safe(s, 0, 12)}…${sliceUtf16Safe(s, -4)}`;
}

function hasLoneSurrogate(value: string): boolean {
  return /[\uD800-\uDFFF]/.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, ""));
}

const input = `${"a".repeat(11)}😀${"b".repeat(20)}`;
const legacy = legacyShortId(input);
const fixed = fixedShortId(input);

console.log(`input length         : ${input.length}`);
console.log(`legacy shortId       : ${legacy}`);
console.log(`fixed  shortId       : ${fixed}`);
console.log(`legacy lone surrogate: ${hasLoneSurrogate(legacy)}`);
console.log(`fixed  lone surrogate: ${hasLoneSurrogate(fixed)}`);

if (!hasLoneSurrogate(legacy)) {
  console.error("FAIL: expected legacy shortId to emit a lone surrogate");
  process.exit(1);
}

if (hasLoneSurrogate(fixed)) {
  console.error("FAIL: expected fixed shortId to stay surrogate-safe");
  process.exit(1);
}

console.log("PASS: shortId keeps surrogate pairs intact.");
