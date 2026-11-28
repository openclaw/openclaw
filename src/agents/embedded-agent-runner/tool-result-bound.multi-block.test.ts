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

// Fail closed: when not every frame fits, an envelope is left out whole with a trusted notice;
// untrusted text never reaches the model outside a frame.
describe("envelopes whose frames do not fit", () => {
  it.each([4_000, 8_000])("14 wrapped pages at a %i-token window", async (contextWindowTokens) => {
    const pages = Array.from({ length: 14 }, (_, i) =>
      wrapExternalContent(`UNTRUSTED-${i} ${"u".repeat(8_000)}`, { source: "api" }),
    );
    const bounded = await boundToolResult(
      { content: pages.map((text) => ({ type: "text", text })), details: {} },
      contextWindowTokens,
      false,
    );
    const texts = bounded.content.map((block) => (block as { text?: string }).text ?? "");
    const shownIds = new Set<string>();
    for (const text of texts) {
      // Remove every whole frame region; nothing untrusted may remain outside one.
      const outside = text.replace(
        /<<<EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\1">>>/gu,
        (region, id: string) => {
          shownIds.add(id);
          return "";
        },
      );
      expect(outside).not.toMatch(/UNTRUSTED-|uuuu|EXTERNAL_UNTRUSTED_CONTENT/u);
    }
    // Frames are kept in order while they fit, so the pages left out whole are the last ones;
    // the trusted notice is the last block, outside every frame, and counts exactly those.
    const notice = /^\[\.\.\. (\d+) chars omitted\]$/u.exec(texts.at(-1) ?? "");
    expect(notice).not.toBeNull();
    const count = Number(notice![1]);
    const tails = pages.map((_, i) =>
      pages.slice(i).reduce((sum, wrapped) => sum + wrapped.length, 0),
    );
    expect(tails).toContain(count);
    // No page shown in a frame is counted as left out.
    const leftOut = pages.slice(tails.indexOf(count));
    for (const wrapped of leftOut) {
      expect(shownIds.has(/id="([a-f0-9]{16})"/u.exec(wrapped)![1]!)).toBe(false);
    }
  });
});
