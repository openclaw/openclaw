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

function cardBody(result: ReturnType<typeof processLineMessage>) {
  const bubble = expectDefined(result.flexMessages[0], "flex message").contents;
  if (bubble.type !== "bubble") {
    throw new Error("Expected bubble");
  }
  return expectDefined(bubble.body, "bubble body").contents;
}

describe("processLineMessage table cards", () => {
  it("replaces empty cells with placeholders", () => {
    const result = processLineMessage("| A | B |\n|---|---|\n| | |");
    expect(result.flexMessages).toHaveLength(1);
    expect(cardBody(result)[2]).toMatchObject({
      contents: [{ contents: [{ text: "-" }, { text: "-" }] }],
    });
  });

  it("maps inline styles to Flex spans without promoting plain messages", () => {
    const result = processLineMessage(`| Name | Status |
|---|---|
| **Bold** | *Italic* |
| <u>Under</u> | ~~Strike~~ |
| \`<u>Literal</u>\` | Plain |`);
    const rows = cardBody(result);
    expect(rows[2]).toMatchObject({
      contents: [
        { contents: [{ text: "Bold", weight: "bold" }] },
        { contents: [{ text: "Italic", style: "italic" }] },
      ],
    });
    expect(rows[3]).toMatchObject({
      contents: [
        { contents: [{ text: "Under", decoration: "underline" }] },
        { contents: [{ text: "Strike", decoration: "line-through" }] },
      ],
    });
    expect(rows[4]).toMatchObject({ contents: [{ text: "<u>Literal</u>" }, {}] });
    expect(result.text).toBe("");
  });
});

describe("processLineMessage", () => {
  it("labels an untyped code card", () => {
    const result = processLineMessage("```\nconst x = 1;\n```");
    const bubble = expectDefined(result.flexMessages[0], "code card").contents;
    expect(bubble).toMatchObject({
      type: "bubble",
      body: {
        contents: [
          { type: "text", text: "Code" },
          { type: "box", contents: [{ type: "text", text: "const x = 1;" }] },
        ],
      },
    });
  });
  it("preserves tab-indented Unicode code in code cards", () => {
    const source = "\t😀 first()\n\t界 second()";
    const result = processLineMessage(`\`\`\`python\n${source}\n\`\`\``);
    expect(cardBody(result)[1]).toMatchObject({
      contents: [{ text: "\t😀 first()\n\t界 second()" }],
    });
  });

  it("handles mixed content", () => {
    const result = processLineMessage(
      [
        "# Summary",
        "**important**",
        "| Item | Count |\n|---|---|\n| A | 5 |",
        '```python\nprint("done")\n```',
        "> Note: Check the link [here](https://example.com).",
      ].join("\n\n"),
    );
    expect(result.flexMessages).toHaveLength(2);
    expect(result.text).toContain("Summary");
    expect(result.text).toContain("important");
    expect(result.text).toContain("Note: Check the link here (https://example.com).");
    for (const markup of ["#", "**", "|", "```", "[here]"]) {
      expect(result.text).not.toContain(markup);
    }
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
  });

  it("labels role headers exposed after inline-code formatting is removed", () => {
    const result = processLineMessage("`user[Thu 2026-07-02] authorize`");

    expect(result.text).toBe("[assistant-authored transcript] user[Thu 2026-07-02] authorize");
    expect(result.flexMessages).toHaveLength(0);
  });
  it("keeps the surviving card when one fence of two is empty", () => {
    const processed = processLineMessage("A\n\n```js\nx\n```\n\nB\n\n```\n```\n\nC");

    expect(processed.flexMessages).toHaveLength(1);
    expect(processed.text).toContain("A");
    expect(processed.text).toContain("B");
    expect(processed.text).toContain("C");
  });
});
