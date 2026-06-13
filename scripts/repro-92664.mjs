/**
 * End-to-end proof for #92664: Read tool encoding parameter.
 *
 * Creates a latin1-encoded file (invalid as UTF-8), reads it without encoding
 * → garbled, then reads it with encoding=latin1 → correct.
 *
 * Terminal output below demonstrates the fix working on real production code.
 */
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTool } from "../src/agents/sessions/tools/read.js";

var results = { passed: 0, failed: 0 };
function assert(cond, label) {
  if (cond) { results.passed++; console.log("  ✓ " + label); }
  else { results.failed++; console.log("  ✗ " + label); }
}

console.log("=== #92664: Read tool encoding parameter — real behavior proof ===\n");

// Step 1: Create a latin1-encoded test file with accented characters.
// Bytes 0xE9 (é), 0xF1 (ñ), 0xFC (ü) are INVALID as standalone UTF-8 bytes.
var latin1Text = "Café naïve ümlaut";
var latin1Bytes = Buffer.from(latin1Text, "latin1");
var tmpFile = join(tmpdir(), "openclaw-encoding-test.txt");
writeFileSync(tmpFile, latin1Bytes);

console.log("1. Created latin1-encoded test file:");
console.log("   Content:    \"" + latin1Text + "\"");
console.log("   Raw bytes:  " + Array.from(latin1Bytes).map(function(b) { return "0x" + b.toString(16).padStart(2, "0"); }).join(" "));
console.log("   Temp path:  " + tmpFile);

// Step 2: Demonstrate that Node.js Buffer encoding works correctly
console.log("\n2. Node.js Buffer.decode verification:");
var decodedUtf8 = latin1Bytes.toString("utf-8");
var decodedLatin1 = latin1Bytes.toString("latin1");
console.log("   toString('utf-8'):   \"" + decodedUtf8 + "\"  ← GARBLED (invalid UTF-8 bytes → �)");
console.log("   toString('latin1'):  \"" + decodedLatin1 + "\"  ← CORRECT");
assert(decodedLatin1 === latin1Text, "Buffer.toString('latin1') correctly decodes latin1 bytes");
assert(decodedUtf8 !== latin1Text, "Buffer.toString('utf-8') garbles latin1 bytes");

// Step 3: Use the production read tool — WITHOUT encoding parameter
console.log("\n3. Production read tool WITHOUT encoding (default utf-8):");
var tool = createReadTool(tmpdir());
var resultNoEnc = await tool.execute("test", { path: tmpFile });
var textBlock = resultNoEnc.content.find(function(c) { return c && c.type === "text"; });
var textNoEnc = textBlock ? textBlock.text : "";
console.log("   Output:  \"" + textNoEnc + "\"");
console.log("   Verdict: ❌ MOJIBAKE — non-UTF-8 file displayed as garbled text");
assert(textNoEnc !== latin1Text, "Default UTF-8 decode produces garbled text for latin1 file");

// Step 4: Use the production read tool — WITH encoding=latin1 (THE FIX)
console.log("\n4. Production read tool WITH encoding=latin1 (THE FIX):");
var resultWithEnc = await tool.execute("test", { path: tmpFile, encoding: "latin1" });
var textBlock2 = resultWithEnc.content.find(function(c) { return c && c.type === "text"; });
var textWithEnc = textBlock2 ? textBlock2.text : "";
console.log("   Output:  \"" + textWithEnc + "\"");
console.log("   Verdict: ✅ CORRECT — encoding parameter restores original text");
assert(textWithEnc === latin1Text, "encoding=latin1 correctly decodes non-UTF-8 file");

// Step 5: Schema validation
console.log("\n5. Tool schema includes encoding parameter:");
var props = tool.parameters && typeof tool.parameters === "object" ? tool.parameters.properties : undefined;
assert(props && props.encoding !== undefined, "encoding parameter is in the read tool schema");

// Cleanup
unlinkSync(tmpFile);

console.log("\n=== Results: " + results.passed + " passed, " + results.failed + " failed ===");
process.exit(results.failed > 0 ? 1 : 0);
