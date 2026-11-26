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

describe("processLineMessage", () => {
  it("keeps valid tables and code cards while downgrading only an oversized sibling table", () => {
    const value = "z".repeat(30_000);
    const result = processLineMessage(
      `First\n\n| Small | Value |\n|---|---|\n| Kept | card |\n\nBetween\n\n| Name | Value |\n|---|---|\n| Large | [${value}](https://example.test/report) |\n\nAfter\n\n\`\`\`js\nconsole.log("still a card");\n\`\`\``,
    );

    expect(result.flexMessages.map((message) => message.altText)).toEqual(["Table", "Code"]);
    expect(result.text).not.toContain("Kept");
    expect(result.text).toContain(`• Value: ${value} (https://example.test/report)`);
    expect(result.text).toMatch(/First[\s\S]*Between[\s\S]*Large[\s\S]*After/);
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
    expect(processed.text).toMatch(/A[\s\S]*B[\s\S]*C/);
  });
});
