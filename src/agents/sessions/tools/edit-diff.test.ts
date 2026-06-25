/**
 * Regression tests for the fuzzy-edit normalization bug (#89994).
 *
 * When any edit falls back to fuzzy matching, normalizeForFuzzyMatch must be
 * used only to locate the match position — the base content must remain the
 * original so that unrelated lines are never silently mutated.
 */
import { describe, expect, it } from "vitest";
import { applyEditsToNormalizedContent, generateDiffString } from "./edit-diff.js";

describe("applyEditsToNormalizedContent fuzzy matching", () => {
  // ── Core regression: issue #89994 repro ──────────────────────────
  it("preserves em dash and trailing whitespace on unrelated lines during fuzzy edit", () => {
    const original =
      'const label = "a — b";\n' + // em dash in unrelated line
      "let x = 1;   \n" + // trailing spaces in unrelated line
      "\n" +
      "function bar() {\n" +
      "  return 2;\n" + // only line targeted by the edit
      "}\n";

    // oldText contains non-breaking spaces (U+00A0) where the file has
    // regular spaces, so exact match fails and fuzzy match takes over.
    const edits = [{ oldText: "  return 2;", newText: "  return 3;" }];

    const { baseContent, newContent } = applyEditsToNormalizedContent(original, edits, "/x.ts");

    // baseContent must be the original, NOT fuzzy-normalized.
    expect(baseContent).toBe(original);

    // Exact output: only the targeted line changes.
    const expected =
      'const label = "a — b";\n' +
      "let x = 1;   \n" +
      "\n" +
      "function bar() {\n" +
      "  return 3;\n" +
      "}\n";
    expect(newContent).toBe(expected);

    // Additional spot checks.
    expect(newContent).toContain("—"); // em dash preserved
    expect(newContent).toContain("let x = 1;   "); // trailing whitespace preserved
    expect(newContent).toContain("  return 3;"); // edit applied
    expect(newContent).not.toContain("return 2;"); // old value gone
  });

  it("preserves smart quotes on unrelated lines during fuzzy edit", () => {
    const original =
      'const msg = "“help”";\n' + // smart double quotes
      "\n" +
      "function foo() {\n" +
      "  return 1;\n" +
      "}\n";

    const edits = [{ oldText: "  return 1;", newText: "  return 2;" }];

    const { newContent } = applyEditsToNormalizedContent(original, edits, "/x.ts");

    // Exact output: smart quotes and unrelated lines preserved.
    const expected =
      'const msg = "“help”";\n' + "\n" + "function foo() {\n" + "  return 2;\n" + "}\n";
    expect(newContent).toBe(expected);
    expect(newContent).toContain("“help”");
    expect(newContent).toContain("  return 2;");
  });

  it("preserves NFKC-relevant Unicode on unrelated lines during fuzzy edit", () => {
    // The string "ﬃ" (U+FB03, LATIN SMALL LIGATURE FFI) is NFKC-normalized
    // to "ffi", so it would be silently corrupted by the old code.
    const original =
      'const ligature = "ﬃ";\n' + // ﬃ
      "\n" +
      "function foo() {\n" +
      "  return 1;\n" +
      "}\n";

    const edits = [{ oldText: "  return 1;", newText: "  return 2;" }];

    const { newContent } = applyEditsToNormalizedContent(original, edits, "/x.ts");

    // Exact output: ligature preserved, only the targeted line changed.
    const expected =
      'const ligature = "ﬃ";\n' + "\n" + "function foo() {\n" + "  return 2;\n" + "}\n";
    expect(newContent).toBe(expected);
    expect(newContent).toContain("ﬃ");
    expect(newContent).toContain("  return 2;");
  });

  // ── Multiple edits with mixed match types ────────────────────────
  it("preserves exact-match lines when another edit in the same batch uses fuzzy", () => {
    const original =
      "const a = 1;\n" +
      'const label = "a — b";\n' + // em dash — should survive
      "  const b = 2;\n" + // has leading spaces (matches NBSP in oldText)
      "const c = 3;\n";

    // First edit matches exactly; second needs fuzzy (NBSP in oldText
    // normalizes to space, which matches the spaces in the original).
    const edits = [
      { oldText: "const a = 1;", newText: "const a = 10;" },
      {
        oldText: "  const b = 2;",
        newText: "  const b = 20;",
      },
    ];

    const { newContent } = applyEditsToNormalizedContent(original, edits, "/x.ts");

    expect(newContent).toContain("const a = 10;");
    expect(newContent).toContain("  const b = 20;");
    expect(newContent).toContain("—"); // em dash preserved
    expect(newContent).toContain("const c = 3;");
  });

  // ── Diff honesty ─────────────────────────────────────────────────
  it("produces a diff that reflects only the intended change, not normalization", () => {
    const original =
      'const label = "a — b";\n' +
      "let x = 1;   \n" +
      "\n" +
      "function bar() {\n" +
      "  return 2;\n" +
      "}\n";

    const edits = [{ oldText: "  return 2;", newText: "  return 3;" }];

    const { baseContent, newContent } = applyEditsToNormalizedContent(original, edits, "/x.ts");
    const { diff } = generateDiffString(baseContent, newContent);

    // The diff shows the intended change — return 2 → return 3.
    expect(diff).toContain("return 2;");
    expect(diff).toContain("return 3;");

    // Unrelated lines must NOT appear as added (+) or removed (-) lines.
    // They may appear as context lines (prefix "  N ") but NOT as changes.
    const changedLines = diff.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-"));
    const changedStr = changedLines.join("\n");
    expect(changedStr).not.toContain("const label");
    expect(changedStr).not.toContain("let x = 1");
  });

  // ── Exact match path: regression guard ───────────────────────────
  it("exact match preserves all content unchanged except the edited region", () => {
    const original =
      'const label = "a — b";\n' +
      "let x = 1;   \n" +
      "function bar() {\n" +
      "  return 2;\n" +
      "}\n";

    const edits = [{ oldText: "  return 2;", newText: "  return 3;" }];

    const { baseContent, newContent } = applyEditsToNormalizedContent(original, edits, "/x.ts");

    // Exact match: baseContent should equal original.
    expect(baseContent).toBe(original);
    expect(newContent).toContain("—");
    expect(newContent).toContain("let x = 1;   ");
    expect(newContent).toContain("  return 3;");
  });

  // ── Error behaviour ──────────────────────────────────────────────
  it("still throws when oldText is not found even with fuzzy matching", () => {
    const original = "line one\nline two\nline three\n";

    const edits = [{ oldText: "this text does not exist anywhere", newText: "nope" }];

    expect(() => applyEditsToNormalizedContent(original, edits, "/x.ts")).toThrow(/Could not find/);
  });
});
