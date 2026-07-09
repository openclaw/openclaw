// Proof: raw slice(0, N) splits a surrogate pair in restart-handoff reasons,
// while the surrogate-safe helper used by normalizeText does not.

import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const MAX_REASON_LENGTH = 200;
const prefix = "a".repeat(199);
const reason = `${prefix}😀suffix`;

const legacy = reason.slice(0, MAX_REASON_LENGTH);
const fixed = reason.length > MAX_REASON_LENGTH
  ? truncateUtf16Safe(reason, MAX_REASON_LENGTH)
  : reason;

function hasLoneSurrogate(value: string): boolean {
  return /[\uD800-\uDFFF]/.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, ""));
}

console.log(`input length   : ${reason.length}`);
console.log(`legacy length  : ${legacy.length}`);
console.log(`fixed length   : ${fixed.length}`);
console.log(`legacy lone surrogate: ${hasLoneSurrogate(legacy)}`);
console.log(`fixed lone surrogate : ${hasLoneSurrogate(fixed)}`);

if (!hasLoneSurrogate(legacy)) {
  console.error("FAIL: expected legacy slice to emit a lone surrogate");
  process.exit(1);
}

if (hasLoneSurrogate(fixed) || fixed.length > MAX_REASON_LENGTH) {
  console.error("FAIL: expected fixed truncation to stay bounded and surrogate-safe");
  process.exit(1);
}

console.log("PASS: legacy splits surrogate pair; fixed truncation is safe.");
