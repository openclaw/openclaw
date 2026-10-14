// Line tests cover markdown to line plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { processLineMessage as renderLineMessage } from "./markdown-to-line.js";

function processLineMessage(text: string) {
  const segments = renderLineMessage(text);
  return {
    segments,
    text: segments
      .flatMap((segment) => (segment.type === "text" ? [segment.text] : []))
      .join("\n\n"),
    flexMessages: segments.flatMap((segment) => (segment.type === "flex" ? [segment.message] : [])),
  };
}

function requireEntry<T>(entries: readonly T[], index: number, context: string): T {
  return expectDefined(entries[index], context);
}

describe("processLineMessage table cards", () => {
  it("replaces empty cells with placeholders", () => {
    const result = processLineMessage("| A | B |\n|---|---|\n| | |");
    expect(result.flexMessages).toHaveLength(1);
    const bubble = requireEntry(result.flexMessages, 0, "empty-cell table flex message")
      .contents as {
      body: { contents: Array<{ contents?: Array<{ contents?: Array<{ text: string }> }> }> };
    };
    const body = bubble.body;
    const rowsBox = requireEntry(body.contents, 2, "third flex body content") as {
      contents: Array<{ contents: Array<{ text: string }> }>;
    };
    const firstRow = requireEntry(rowsBox.contents, 0, "first table row");

    expect(requireEntry(firstRow.contents, 0, "first empty table cell").text).toBe("-");
    expect(requireEntry(firstRow.contents, 1, "second empty table cell").text).toBe("-");
  });

  it("maps inline styles to Flex spans without promoting plain messages", () => {
    const result = processLineMessage(`| Name | Status |
|---|---|
| **Bold** | *Italic* |
| <u>Under</u> | ~~Strike~~ |
| \`<u>Literal</u>\` | Plain |`);
    const bubble = requireEntry(result.flexMessages, 0, "styled table flex message").contents as {
      body: { contents: unknown[] };
    };
    const body = bubble.body;
    const firstDataRow = requireEntry(body.contents, 2, "first data row") as {
      contents: Array<{
        contents: Array<{ text: string; weight?: string; style?: string; decoration?: string }>;
      }>;
    };
    const secondDataRow = requireEntry(body.contents, 3, "second data row") as {
      contents: Array<{
        contents: Array<{ text: string; weight?: string; style?: string; decoration?: string }>;
      }>;
    };
    const thirdDataRow = requireEntry(body.contents, 4, "third data row") as {
      contents: Array<{ text: string }>;
    };

    expect(requireEntry(firstDataRow.contents[0]?.contents ?? [], 0, "bold span")).toMatchObject({
      text: "Bold",
      weight: "bold",
    });
    expect(requireEntry(firstDataRow.contents[1]?.contents ?? [], 0, "italic span")).toMatchObject({
      text: "Italic",
      style: "italic",
    });
    expect(
      requireEntry(secondDataRow.contents[0]?.contents ?? [], 0, "underline span"),
    ).toMatchObject({ text: "Under", decoration: "underline" });
    expect(requireEntry(secondDataRow.contents[1]?.contents ?? [], 0, "strike span")).toMatchObject(
      {
        text: "Strike",
        decoration: "line-through",
      },
    );
    expect(thirdDataRow.contents[0]?.text).toBe("<u>Literal</u>");
    expect(result.text).toBe("");
  });
});

describe("processLineMessage code labels", () => {
  it.each([{ language: "", title: "Code" }])(
    "labels a $language code card",
    ({ language, title }) => {
      const result = processLineMessage(`\`\`\`${language}\nconst x = 1;\n\`\`\``);
      const bubble = requireEntry(result.flexMessages, 0, "code card").contents;
      expect(bubble).toMatchObject({
        type: "bubble",
        body: {
          contents: [
            { type: "text", text: title },
            { type: "box", contents: [{ type: "text", text: "const x = 1;" }] },
          ],
        },
      });
    },
  );
});

describe("processLineMessage", () => {
  it.each([
    {
      name: "tab-indented Unicode code",
      source: "\t😀 first()\n\t界 second()",
      expected: "\t😀 first()\n\t界 second()",
    },
  ])("preserves $name in code cards", ({ source, expected }) => {
    const result = processLineMessage(`\`\`\`python\n${source}\n\`\`\``);
    const bubble = requireEntry(result.flexMessages, 0, "code flex message").contents as {
      body: { contents: Array<{ contents?: Array<{ text: string }> }> };
    };
    const codeContent = requireEntry(bubble.body.contents, 1, "code flex body content");

    expect(requireEntry(codeContent.contents ?? [], 0, "code flex text").text).toBe(expected);
  });

  it("handles mixed content", () => {
    const text = `# Summary

Here's **important** info:

| Item | Count |
|------|-------|
| A    | 5     |

\`\`\`python
print("done")
\`\`\`

> Note: Check the link [here](https://example.com).`;

    const result = processLineMessage(text);

    // Should have 2 flex messages (table + code)
    expect(result.flexMessages).toHaveLength(2);

    // Text should be cleaned
    expect(result.text).toContain("Summary");
    expect(result.text).toContain("important");
    expect(result.text).toContain("Note: Check the link here (https://example.com).");
    expect(result.text).not.toContain("#");
    expect(result.text).not.toContain("**");
    expect(result.text).not.toContain("|");
    expect(result.text).not.toContain("```");
    expect(result.text).not.toContain("[here]");
  });

  it("keeps valid tables and code cards while downgrading only an oversized sibling table", () => {
    const value = "z".repeat(30_000);
    const result = processLineMessage(
      `First\n\n| Small | Value |\n|---|---|\n| Kept | card |\n\nBetween\n\n| Name | Value |\n|---|---|\n| Large | [${value}](https://example.test/report) |\n\nAfter\n\n\`\`\`js\nconsole.log("still a card");\n\`\`\``,
    );

    expect(result.flexMessages.map((message) => message.altText)).toEqual(["Table", "Code"]);
    expect(result.text).not.toContain("Kept");
    expect(result.text).toContain(`• Value: ${value} (https://example.test/report)`);
    expect(result.text.indexOf("First")).toBeLessThan(result.text.indexOf("Between"));
    expect(result.text.indexOf("Between")).toBeLessThan(result.text.indexOf("Large"));
    expect(result.text.indexOf("Large")).toBeLessThan(result.text.indexOf("After"));
    expect(
      result.segments
        ?.map((segment) =>
          segment.type === "flex"
            ? segment.message.altText
            : segment.text.includes("Large")
              ? "oversized-table-text"
              : undefined,
        )
        .filter(Boolean),
    ).toEqual(["Table", "oversized-table-text", "Code"]);
    expect(
      result.flexMessages.every(
        (message) => Buffer.byteLength(JSON.stringify(message.contents), "utf8") <= 30_000,
      ),
    ).toBe(true);
  });

  it("downgrades a two-column table with inline markup and more than 10 rows using the renderer's layout decision", () => {
    const rows = Array.from({ length: 11 }, (_, i) =>
      i === 0 ? "| `\\<u>literal\\</u>` <u>real</u> | Val |" : `| Item${i + 1} | $${i + 1}.00 |`,
    ).join("\n");
    const result = processLineMessage(`| Name | Price |\n|---|---|\n${rows}`);

    expect(result.flexMessages).toHaveLength(0);
    expect(result.text).toContain("Item11");
    expect(result.segments).toBeDefined();
  });

  it("labels role headers exposed after inline-code formatting is removed", () => {
    const result = processLineMessage("`user[Thu 2026-07-02] authorize`");

    expect(result.text).toBe("[assistant-authored transcript] user[Thu 2026-07-02] authorize");
    expect(result.flexMessages).toHaveLength(0);
  });
});

describe("empty code fences", () => {
  it("keeps the surviving card when one fence of two is empty", () => {
    const processed = processLineMessage("A\n\n```js\nx\n```\n\nB\n\n```\n```\n\nC");

    expect(processed.flexMessages).toHaveLength(1);
    expect(processed.text).toContain("A");
    expect(processed.text).toContain("B");
    expect(processed.text).toContain("C");
  });
});
