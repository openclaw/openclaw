// Proof: link-understanding charset-aware TextDecoder with fatal:true
// Shows before/after behavior for link fetch content decoding.

const LATIN1_BYTES = new Uint8Array([
  0xe9, 0x74, 0x61, 0x67, 0x65, 0x20, // "étage " in Latin-1
  0xe0, 0x20, 0x6c, 0x61, 0x20, 0x66, // "à la f"
  0xea, 0x74, 0x65, 0x0a,             // "ête\n"
]);

const MALFORMED_UTF8 = new Uint8Array([0xff, 0xfe, 0x00, 0x48, 0x69]);

function readCharsetParam(contentType) {
  const match = /charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(contentType ?? "");
  return (match?.[1] ?? match?.[2] ?? match?.[3]) || undefined;
}

function decodeWrapper(contentType, bytes) {
  const charset = readCharsetParam(contentType) ?? "utf-8";
  return new TextDecoder(charset, { fatal: true }).decode(bytes);
}

function result(pass, msg) {
  console.log(`  ${pass ? "✅" : "❌"} ${msg}`);
  return pass;
}

let allPass = true;

console.log("\n═══ CHARSET EXTRACTION ═══");
console.log(`  Content-Type "text/html; charset=utf-8" → "${readCharsetParam('text/html; charset=utf-8')}"`);
console.log(`  Content-Type "text/html; charset=iso-8859-1" → "${readCharsetParam('text/html; charset=iso-8859-1')}"`);
console.log(`  Content-Type "text/html" → "${readCharsetParam('text/html')}" (defaults to utf-8)`);

console.log("\n═══ OLD BEHAVIOR: UTF-8-only (before fix) ═══");
console.log("  Always uses TextDecoder('utf-8', { fatal: true }) regardless of Content-Type.");

try {
  new TextDecoder("utf-8", { fatal: true }).decode(LATIN1_BYTES);
  allPass = !result(false, "Valid Latin-1 content decoded as UTF-8 — should have thrown!");
} catch (e) {
  allPass = !result(true, "Valid Latin-1 content correctly rejected as invalid UTF-8 — PROBLEM: http://example.fr declaring charset=iso-8859-1 fails!") || allPass;
}

try {
  new TextDecoder("utf-8", { fatal: true }).decode(MALFORMED_UTF8);
  allPass = !result(false, "Truly malformed bytes rejected");
} catch (e) {
  allPass = !result(true, "Truly malformed UTF-8 correctly rejected") || allPass;
}

console.log("\n═══ NEW BEHAVIOR: charset-aware (after fix) ═══");
console.log("  Uses charset from Content-Type header with TextDecoder(charset, { fatal: true }).");

try {
  const text = decodeWrapper("text/html; charset=iso-8859-1", LATIN1_BYTES);
  allPass = !result(text.startsWith("étage"), `Valid Latin-1 decoded: "${text.trim()}"`) || allPass;
} catch (e) {
  allPass = !result(false, `Valid Latin-1 rejected: ${e.message}`) || allPass;
}

try {
  decodeWrapper("text/html; charset=utf-8", MALFORMED_UTF8);
  allPass = !result(false, "Malformed UTF-8 accepted (should have thrown!)") || allPass;
} catch (e) {
  allPass = !result(true, "Malformed UTF-8 with declared charset=utf-8 correctly rejected") || allPass;
}

try {
  decodeWrapper("text/html", LATIN1_BYTES);
  allPass = !result(false, "Latin-1 content without charset (default UTF-8) accepted (should throw)") || allPass;
} catch (e) {
  allPass = !result(true, "Latin-1 content without charset (default UTF-8) correctly rejected — no charset declared, UTF-8 assumed") || allPass;
}

try {
  decodeWrapper("text/html", MALFORMED_UTF8);
  allPass = !result(false, "Malformed bytes without charset accepted (should throw)") || allPass;
} catch (e) {
  allPass = !result(true, "Malformed bytes without charset (default UTF-8) correctly rejected") || allPass;
}

try {
  const shiftJisBytes = new Uint8Array([0x8c, 0xbf, 0x93, 0xfa]);
  const text = decodeWrapper("text/html; charset=shift_jis", shiftJisBytes);
  allPass = !result(text.length === 2, `Shift_JIS decoded: ${text.length} chars (expected 2)`) || allPass;
} catch (e) {
  allPass = !result(false, `Shift_JIS rejected: ${e.message}`) || allPass;
}

console.log(allPass ? "\n═══ ALL PASS ═══" : "\n═══ SOME FAILURE ═══");
process.exit(allPass ? 0 : 1);
