import { describe, expect, it } from "vitest";
import { wrapExternalContent } from "../../security/external-content.js";
import { boundToolResult } from "./tool-result-bound.js";

const MARKER = /<<<(END_)?EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>/gu;
const page = (label: string) =>
  wrapExternalContent(`${label}-FIRST\n${"x".repeat(60_000)}\n${label}-LAST`, { source: "api" });

function markersPerBlock(content: unknown[]) {
  return content.flatMap((block) => {
    const text =
      (block as { type?: string; text?: string }).type === "text"
        ? (block as { text: string }).text
        : "";
    const found = [...text.matchAll(MARKER)].map((m) => `${m[1] ? "end" : "start"}:${m[2]}`);
    return found.length > 0 ? [found] : [];
  });
}

// Each kept envelope block must open and close with one id; a cut must never leave a block
// with a start marker and no end marker.
function expectClosedEnvelopes(content: unknown[]) {
  for (const found of markersPerBlock(content)) {
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(/^start:/u);
    expect(found[1]).toBe(found[0]!.replace("start:", "end:"));
  }
}

describe("multi-block results keep their untrusted-content blocks closed", () => {
  it.each([4_000, 8_000, 16_000, 128_000])(
    "a header block beside one wrapped page: %i-token window",
    async (contextWindowTokens) => {
      const bounded = await boundToolResult(
        {
          content: [
            { type: "text", text: "Fetched 1 page." },
            { type: "text", text: page("A") },
          ],
          details: {},
        },
        contextWindowTokens,
        false,
      );
      expect(markersPerBlock(bounded.content)).toHaveLength(1);
      expectClosedEnvelopes(bounded.content);
      expect(JSON.stringify(bounded.content)).toMatch(/chars omitted/u);
    },
  );

  it.each([4_000, 16_000, 128_000])(
    "two wrapped pages: %i-token window",
    async (contextWindowTokens) => {
      const bounded = await boundToolResult(
        {
          content: [
            { type: "text", text: page("A") },
            { type: "text", text: page("B") },
          ],
          details: {},
        },
        contextWindowTokens,
        false,
      );
      // Both pages keep a closed frame; a lost tag would ship a body with no frame at all.
      expect(markersPerBlock(bounded.content)).toHaveLength(2);
      expectClosedEnvelopes(bounded.content);
    },
  );
});
