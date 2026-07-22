import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { describe, expect, it } from "vitest";
import { truncateCdpPageTextPreview } from "./cdp-page-text-preview.js";

describe("truncateCdpPageTextPreview", () => {
  const hasLoneSurrogate = (value: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(value);
  // Emoji at positions 99-100 (0-indexed) — the exact boundary where
  // .slice(0, 100) captures the high surrogate but drops the low one.
  const boundaryText = `${"a".repeat(99)}😀`;

  it("keeps emoji intact at the shared 100-unit cursor preview budget", () => {
    // The legacy page `.slice(0, 101)` captures the high surrogate of 😀
    // (which starts at position 100) but drops the low surrogate at 101.
    // Page-local helper must rewind past the split and never emit a lone
    // surrogate on the CDP wire.
    const raw = `${"a".repeat(100)}😀`; // 102 units, 😀 at 100-101
    const oldPageSlice = raw.slice(0, 101);
    // The old page slice leaves a lone surrogate:
    expect(hasLoneSurrogate(oldPageSlice)).toBe(true);

    // New page-local truncate at the same final budget (100):
    const preview = truncateCdpPageTextPreview(raw, 100);
    expect(preview).toBe("a".repeat(100));
    expect(hasLoneSurrogate(preview)).toBe(false);
  });

  it("scrubs a lone high surrogate already present at length===max", () => {
    // When an earlier unsafe cut (e.g. .slice(0, 100)) already produced a 100-unit
    // string ending in a high surrogate, Node truncateUtf16Safe(_, 100) is a no-op
    // because the string is already at the budget. Page-local truncate must repair
    // that residue — not only avoid creating one during its own cut.
    const unsafe = boundaryText.slice(0, 100);
    expect(unsafe.length).toBe(100);
    expect(hasLoneSurrogate(unsafe)).toBe(true);
    // Node/SDK helper cannot fix an already-at-cap string:
    expect(hasLoneSurrogate(truncateUtf16Safe(unsafe, 100))).toBe(true);

    const preview = truncateCdpPageTextPreview(unsafe, 100);
    expect(preview).toBe("a".repeat(99));
    expect(hasLoneSurrogate(preview)).toBe(false);
  });

  it("is injectable into Runtime.evaluate without calling Node/SDK truncate", () => {
    // Function#toString must embed only dependency-free code — any reference to
    // Node/SDK helpers like truncateUtf16Safe throws ReferenceError in the page
    // context and silently empties the cursor-interactive map.
    const expression = `(() => {
      const truncateCdpPageTextPreview = ${truncateCdpPageTextPreview.toString()};
      return truncateCdpPageTextPreview(${JSON.stringify(boundaryText)}, 100);
    })()`;
    expect(expression).toContain("function truncateCdpPageTextPreview");
    expect(expression).not.toMatch(/\btruncateUtf16Safe\s*\(/);
    // Same algorithm the injected source embeds — no Function/eval in tests.
    expect(truncateCdpPageTextPreview(boundaryText, 100)).toBe("a".repeat(99));
  });

  it("produces equivalent final output through the actual page-101 + Node-100 pipeline", () => {
    // The current main pipeline uses page `.slice(0, 101)` → Node
    // `truncateUtf16Safe(_, 100)`.  The proposed pipeline changes the page side
    // to `truncateCdpPageTextPreview(_, 100)`.  Both must reach identical final
    // cursor text, but the new pipeline must never let a lone surrogate cross the
    // CDP returnByValue wire (transport hardening).
    const texts = [
      `${"a".repeat(99)}😀`, // emoji at 99-100; .slice(0,100) leaves lone high
      `${"a".repeat(100)}😀`, // emoji starts at position 100
      `${"a".repeat(99)}😀b`, // emoji at 99-100, extra char at 101+
      "😀".repeat(50), // all emoji, alternating pairs
      "a".repeat(200), // plain ASCII, no surrogates
      `${"a".repeat(50)}${"😀".repeat(30)}`, // mixed ASCII + emoji
    ];

    for (const raw of texts) {
      // Old pipeline: page .slice(0, 101) → Node truncateUtf16Safe(_, 100)
      const oldPage = raw.slice(0, 101);
      const oldFinal = truncateUtf16Safe(oldPage, 100);

      // New pipeline: page truncateCdpPageTextPreview(_, 100) → Node truncateUtf16Safe(_, 100)
      const newPage = truncateCdpPageTextPreview(raw, 100);
      const newFinal = truncateUtf16Safe(newPage, 100);

      // Final cursor preview text must be identical between old and new pipelines.
      expect(newFinal).toBe(oldFinal);

      // New page output must never have a lone surrogate on the wire.
      expect(hasLoneSurrogate(newPage)).toBe(false);

      // If the old pipeline put a malformed surrogate on the wire, the new one
      // must have cleaned it (this is the transport hardening improvement).
      if (hasLoneSurrogate(oldPage)) {
        expect(hasLoneSurrogate(newPage)).toBe(false);
      }
    }
  });
});
