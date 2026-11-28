import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { wrapExternalContent, wrapWebContent } from "../../security/external-content.js";
import { boundToolResult } from "./tool-result-bound.js";
import { installToolResultContextGuard } from "./tool-result-context-guard.js";

type Block = { type: string; text?: string; data?: string; mimeType?: string };

// A whole frame, raw or JSON-escaped: start marker through the end marker with the same id.
const FRAME =
  /<<<EXTERNAL_UNTRUSTED_CONTENT id=(\\*)"([a-f0-9]{16})\1">>>[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT id=\1"\2\1">>>/gu;
const NOTICE = /\[\.\.\. (\d+) chars omitted(?:\. Full output: ([^\]\n]+))?\]/gu;
const ELISION = "\n…\n";
const textOf = (content: unknown[]) =>
  content.map((block) => ((block as Block).type === "text" ? ((block as Block).text ?? "") : ""));

/**
 * The fail-closed contract: untrusted text (every payload carries `UNTRUSTED-` and long filler
 * runs) appears only inside a whole frame, every start marker has its end marker, one trusted
 * notice sits outside every frame with the true omitted count, and the context guard that runs
 * next passes every text block unchanged (it may only drop images, with its own notice).
 */
async function expectFailClosed(
  content: Block[],
  contextWindowTokens: number,
  spill: Parameters<typeof boundToolResult>[2] = false,
) {
  const bounded = await boundToolResult({ content, details: {} }, contextWindowTokens, spill);
  const texts = textOf(bounded.content);
  const shown: string[] = [];
  for (const text of texts) {
    const outside = text.replace(FRAME, (frame) => {
      shown.push(frame);
      return "";
    });
    expect(outside).not.toMatch(/UNTRUSTED-|EXTERNAL_UNTRUSTED_CONTENT|(.)\1{39}/u);
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
  const agent = { transformContext: async (messages: unknown[]) => messages };
  const cleanup = installToolResultContextGuard({ agent: agent as never, contextWindowTokens });
  let seen: unknown[] = [];
  try {
    seen = await agent.transformContext([
      { ...makeTextToolResult("c1", "fixture", "", false, 1), ...bounded },
    ]);
  } finally {
    cleanup();
  }
  const textBlocks = (blocks: unknown[]) =>
    blocks
      .filter((block) => (block as Block).type === "text")
      .map((block) => (block as Block).text);
  expect(
    textBlocks((seen[0] as { content: unknown[] }).content).filter(
      (text) => !/^\[\d+ images? omitted from context/u.test(text ?? ""),
    ),
  ).toEqual(textBlocks(bounded.content));
  return { bounded, shown, notice };
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

  // At 4k and 8k the image alone exceeds the share: the guard drops it and adds its notice, which
  // the bound reserved, so the guard does not cut the frame again (a browser snapshot's shape).
  it.each([4_000, 8_000, 16_000])(
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

  // Where the reader can open Gateway files, the one notice names the file with the full text.
  it("names the saved file in the notice outside every frame", async () => {
    const results = Array.from({ length: 5 }, (_, i) => ({
      snippet: wrapWebContent(`UNTRUSTED-snippet-${i} ${"s".repeat(8_000)}`),
    }));
    const full = JSON.stringify({ results });
    const { notice } = await expectFailClosed([{ type: "text", text: full }], 16_000, {});
    expect(notice[2]).toBeDefined();
    expect(await fs.readFile(notice[2]!, "utf8")).toBe(full);
  });
});
