import { describe, expect, it } from "vitest";
import { wrapExternalContent, wrapWebContent } from "../../security/external-content.js";
import { boundToolResult } from "./tool-result-bound.js";

type Block = { type: string; text?: string; data?: string; mimeType?: string };

// A whole frame, raw or JSON-escaped: start marker through the end marker with the same id.
const FRAME =
  /<<<EXTERNAL_UNTRUSTED_CONTENT id=(\\*)"([a-f0-9]{16})\1">>>[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT id=\1"\2\1">>>/gu;
const NOTICE = /\[\.\.\. (\d+) chars omitted\]/gu;
const ELISION = "\n…\n";
const textOf = (content: unknown[]) =>
  content.map((block) => ((block as Block).type === "text" ? ((block as Block).text ?? "") : ""));

/**
 * The fail-closed contract: untrusted text (every payload carries `UNTRUSTED-`) appears only
 * inside a whole frame, every start marker has its end marker, one trusted notice sits outside
 * every frame with the true omitted count, and the result is a fixed point of the bound.
 */
async function expectFailClosed(content: Block[], contextWindowTokens: number) {
  const bounded = await boundToolResult({ content, details: {} }, contextWindowTokens, false);
  const texts = textOf(bounded.content);
  const shown: string[] = [];
  for (const text of texts) {
    const outside = text.replace(FRAME, (frame) => {
      shown.push(frame);
      return "";
    });
    expect(outside).not.toMatch(/UNTRUSTED-|EXTERNAL_UNTRUSTED_CONTENT/u);
  }
  const notices = texts.flatMap((text) => [...text.matchAll(NOTICE)]);
  expect(notices).toHaveLength(1);
  expect(shown.join("")).not.toMatch(NOTICE);
  const notice = notices[0]!;
  // Every char sent is an original char except the notice, its blank line and an elision.
  const sent = texts.join("").length - notice[0].length - 2;
  const elided = texts.join("").split(ELISION).length - 1;
  const original = textOf(content).join("").length;
  expect(Number(notice[1])).toBe(original - (sent - elided * ELISION.length));
  expect(await boundToolResult(bounded, contextWindowTokens, false)).toBe(bounded);
  return { bounded, shown };
}

const page = (label: string) =>
  wrapExternalContent(`UNTRUSTED-${label}-FIRST\n${"x".repeat(60_000)}\n${label}-LAST`, {
    source: "api",
  });

describe("untrusted-content frames survive the bound", () => {
  it.each([4_000, 8_000, 16_000, 128_000])(
    "a header block beside one wrapped page: %i-token window",
    async (contextWindowTokens) => {
      const { shown } = await expectFailClosed(
        [
          { type: "text", text: "Fetched 1 page." },
          { type: "text", text: page("A") },
        ],
        contextWindowTokens,
      );
      // The page's frame is cut in its body, head and tail kept.
      expect(shown).toHaveLength(1);
      expect(shown[0]).toContain("UNTRUSTED-A-FIRST");
      expect(shown[0]).toContain("A-LAST");
    },
  );

  it.each([4_000, 16_000, 128_000])(
    "two wrapped pages: %i-token window",
    async (contextWindowTokens) => {
      const { shown } = await expectFailClosed(
        [
          { type: "text", text: page("A") },
          { type: "text", text: page("B") },
        ],
        contextWindowTokens,
      );
      // The first page is cut in its body; the second is left out whole, not cut open.
      expect(shown).toHaveLength(1);
      expect(shown[0]).toContain("UNTRUSTED-A-FIRST");
    },
  );

  it.each([4_000, 8_000])("14 wrapped pages at a %i-token window", async (contextWindowTokens) => {
    await expectFailClosed(
      Array.from({ length: 14 }, (_, i) => ({
        type: "text",
        text: wrapExternalContent(`UNTRUSTED-${i} ${"u".repeat(8_000)}`, { source: "api" }),
      })),
      contextWindowTokens,
    );
  });

  // Fail closed must not starve small pages: the ones that fit keep their whole body.
  it("keeps whole small pages at a 128k window", async () => {
    const { shown } = await expectFailClosed(
      Array.from({ length: 200 }, (_, i) => ({
        type: "text",
        text: wrapExternalContent(`UNTRUSTED-${i} body text ${"b".repeat(400)}`, {
          source: "api",
        }),
      })),
      128_000,
    );
    expect(shown.length).toBeGreaterThan(40);
    for (const [i, frame] of shown.slice(0, -1).entries()) {
      expect(frame).toContain(`UNTRUSTED-${i} body text ${"b".repeat(400)}`);
    }
  });

  // web_search serializes several wrapped values into one JSON text block.
  it.each([4_000, 8_000])(
    "one JSON block with 5 wrapped values: %i-token window",
    async (contextWindowTokens) => {
      const results = Array.from({ length: 5 }, (_, i) => ({
        title: wrapWebContent(`UNTRUSTED-title-${i}`),
        snippet: wrapWebContent(`UNTRUSTED-snippet-${i} ${"s".repeat(1_500)}`),
      }));
      const { shown } = await expectFailClosed(
        [{ type: "text", text: JSON.stringify({ results }) }],
        contextWindowTokens,
      );
      // Cut mid-way: some values kept, the rest left out.
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.length).toBeLessThan(10);
    },
  );

  // An image takes most of a small window's share next to a wrapped page.
  it.each([8_000, 16_000])(
    "an image beside a wrapped page: %i-token window",
    async (contextWindowTokens) => {
      await expectFailClosed(
        [
          { type: "image", data: "AA==", mimeType: "image/png" },
          { type: "text", text: page("A") },
        ],
        contextWindowTokens,
      );
    },
  );
});
