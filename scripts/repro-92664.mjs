/**
 * End-to-end proof for #92664: Read tool encoding parameter.
 *
 * Tests GBK-encoded Chinese file reading with the production read tool.
 * Demonstrates the exact scenario from the issue: GBK bytes decoded as
 * UTF-8 → mojibake, then with encoding=gbk → correct Chinese text.
 */
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTool } from "../src/agents/sessions/tools/read.js";

const results = { passed: 0, failed: 0 };
function assert(cond, label) {
  if (cond) { results.passed++; console.log("  ✓ " + label); }
  else { results.failed++; console.log("  ✗ " + label); }
}

console.log("=== #92664: Read tool GBK encoding — real behavior proof ===\n");

// ── Test 1: GBK-encoded Chinese file (the REPORTED bug) ──
// GBK bytes for: "GBK 编码测试\n公司：深圳欧盛自动化"
const gbkChineseBytes = Buffer.from([
  0x47, 0x42, 0x4b, 0x20,  // "GBK "
  0xb1, 0xe0, 0xc2, 0xeb, 0xb2, 0xe2, 0xca, 0xd4,  // "编码测试"
  0x0a,  // "\n"
  0xb9, 0xab, 0xcb, 0xbe, 0xa3, 0xba,  // "公司："
  0xc9, 0xee, 0xdb, 0xda, 0xc5, 0xb7, 0xca, 0xa2, 0xd7, 0xd4, 0xb6, 0xaf, 0xbb, 0xaf  // "深圳欧盛自动化"
]);
const gbkFile = join(tmpdir(), "openclaw-gbk-test.txt");
writeFileSync(gbkFile, gbkChineseBytes);

console.log("1. GBK-encoded Chinese file (the REPORTED bug):");
console.log("   Raw bytes: " + Array.from(gbkChineseBytes.slice(0,12)).map(function(b) { return "0x" + b.toString(16).padStart(2,"0"); }).join(" ") + " ...");
console.log("   Temp path: " + gbkFile);

const tool = createReadTool(tmpdir());

// Read WITHOUT encoding → mojibake (the bug)
console.log("\n2. read WITHOUT encoding → MOJIBAKE (the bug):");
const r1 = await tool.execute("test", { path: gbkFile });
const t1 = r1.content.find(function(c) { return c && c.type === "text"; });
const text1 = t1 ? t1.text : "";
console.log("   Output:  \"" + text1.replace(/\n/g, "\\n") + "\"");
console.log("   Verdict: ❌ GARBLED — GBK bytes decoded as UTF-8");
assert(!text1.includes("深圳欧盛自动化"), "UTF-8 decode cannot read Chinese GBK text");

// Read WITH encoding=gbk → correct Chinese (THE FIX)
console.log("\n3. read WITH encoding=gbk → CORRECT (THE FIX):");
const r2 = await tool.execute("test", { path: gbkFile, encoding: "gbk" });
const t2 = r2.content.find(function(c) { return c && c.type === "text"; });
const text2 = t2 ? t2.text : "";
console.log("   Output:  \"" + text2.replace(/\n/g, "\\n") + "\"");
console.log("   Verdict: ✅ CORRECT — encoding=gbk restores Chinese text");
assert(text2.includes("深圳欧盛自动化"), "encoding=gbk correctly decodes Chinese GBK file");
assert(text2.includes("编码测试"), "encoding=gbk reads GBK header line correctly");

// ── Test 2: latin1 accented chars ──
console.log("\n4. latin1 accented chars (additional encoding proof):");
const latin1Bytes = Buffer.from("Café naïve ümlaut", "latin1");
const latin1File = join(tmpdir(), "openclaw-latin1-test.txt");
writeFileSync(latin1File, latin1Bytes);

const r3 = await tool.execute("test", { path: latin1File });
const t3 = r3.content.find(function(c) { return c && c.type === "text"; });
assert((t3 ? t3.text : "") !== "Café naïve ümlaut", "UTF-8 garbles latin1");

const r4 = await tool.execute("test", { path: latin1File, encoding: "latin1" });
const t4 = r4.content.find(function(c) { return c && c.type === "text"; });
assert((t4 ? t4.text : "") === "Café naïve ümlaut", "encoding=latin1 restores accented text");
console.log("   UTF-8 → garbled ✓   latin1 → correct ✓");

// Cleanup
unlinkSync(gbkFile);
unlinkSync(latin1File);

console.log("\n=== Results: " + results.passed + " passed, " + results.failed + " failed ===");
process.exit(results.failed > 0 ? 1 : 0);
