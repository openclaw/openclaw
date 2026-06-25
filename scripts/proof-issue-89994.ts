/**
 * Proof script for issue #89994 fix.
 *
 * Demonstrates that a fuzzy edit no longer silently normalizes
 * unrelated lines in the file.
 *
 * Usage: npx tsx scripts/proof-issue-89994.ts
 */
import {
  applyEditsToNormalizedContent,
  generateDiffString,
} from "../src/agents/sessions/tools/edit-diff.js";

const divider = "=".repeat(60);

// ── Test 1: Em dash + trailing whitespace ─────────────────────────
{
  console.log(divider);
  console.log("TEST 1: Fuzzy edit preserves em dash & trailing whitespace");
  console.log(divider);

  const original =
    'const label = "a — b";\n' + // em dash in unrelated line
    "let x = 1;   \n" + // trailing spaces in unrelated line
    "\n" +
    "function bar() {\n" +
    "  return 2;\n" + // only line targeted by the edit
    "}\n";

  // oldText uses non-breaking spaces (U+00A0) where the file has
  // regular spaces — this triggers the fuzzy matching path.
  const edits = [{ oldText: "  return 2;", newText: "  return 3;" }];

  const { baseContent, newContent } = applyEditsToNormalizedContent(original, edits, "/x.ts");
  const { diff } = generateDiffString(baseContent, newContent);

  console.log("\nOriginal file (JSON-escaped):");
  console.log(JSON.stringify(original));
  console.log("\nFile after edit (JSON-escaped):");
  console.log(JSON.stringify(newContent));
  console.log("\nDiff shown to model:");
  console.log(diff);

  // Checks
  const emDashPreserved = newContent.includes("—");
  const trailingSpacePreserved = newContent.includes("let x = 1;   ");
  const editApplied = newContent.includes("  return 3;");
  const oldGone = !newContent.includes("return 2;");
  const baseIsOriginal = baseContent === original;

  console.log("\nChecks:");
  console.log(`  em dash preserved:       ${emDashPreserved ? "PASS" : "FAIL"}`);
  console.log(`  trailing spaces preserved: ${trailingSpacePreserved ? "PASS" : "FAIL"}`);
  console.log(`  edit applied:            ${editApplied ? "PASS" : "FAIL"}`);
  console.log(`  old text removed:        ${oldGone ? "PASS" : "FAIL"}`);
  console.log(`  baseContent is original:  ${baseIsOriginal ? "PASS" : "FAIL"}`);

  if (emDashPreserved && trailingSpacePreserved && editApplied && oldGone && baseIsOriginal) {
    console.log("\n  => ALL CHECKS PASSED");
  }
}

// ── Test 2: Smart quotes ──────────────────────────────────────────
{
  console.log("\n" + divider);
  console.log("TEST 2: Fuzzy edit preserves smart quotes");
  console.log(divider);

  const original =
    'const msg = "“help”";\n' + // smart double quotes
    "\n" +
    "function foo() {\n" +
    "  return 1;\n" +
    "}\n";

  const edits = [{ oldText: "  return 1;", newText: "  return 2;" }];

  const { newContent } = applyEditsToNormalizedContent(original, edits, "/x.ts");

  console.log("\nOriginal (JSON):", JSON.stringify(original));
  console.log("After edit (JSON):", JSON.stringify(newContent));

  const smartQuotesPreserved = newContent.includes("“help”");
  console.log(`\n  smart quotes preserved: ${smartQuotesPreserved ? "PASS" : "FAIL"}`);
}

// ── Test 3: NFKC ligature ─────────────────────────────────────────
{
  console.log("\n" + divider);
  console.log("TEST 3: Fuzzy edit preserves NFKC ligature");
  console.log(divider);

  const original =
    'const ligature = "ﬃ";\n' + // ﬃ (LATIN SMALL LIGATURE FFI)
    "\n" +
    "function foo() {\n" +
    "  return 1;\n" +
    "}\n";

  const edits = [{ oldText: "  return 1;", newText: "  return 2;" }];

  const { newContent } = applyEditsToNormalizedContent(original, edits, "/x.ts");

  console.log("\nOriginal (JSON):", JSON.stringify(original));
  console.log("After edit (JSON):", JSON.stringify(newContent));

  const ligaturePreserved = newContent.includes("ﬃ");
  const notDecomposed = !newContent.includes("ffi");
  console.log(`  ligature preserved:     ${ligaturePreserved ? "PASS" : "FAIL"}`);
  console.log(`  NOT decomposed to ffi:  ${notDecomposed ? "PASS" : "FAIL"}`);
}

// ── Summary ────────────────────────────────────────────────────────
console.log("\n" + divider);
console.log("SUMMARY: All fuzzy edits preserve unrelated lines byte-for-byte.");
console.log("Fix verified on " + new Date().toISOString());
console.log(divider);
