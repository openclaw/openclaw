// Telegram rich-message tests cover Bot API 10.1 payload normalization.
import { describe, expect, it } from "vitest";
import { buildTelegramRichHtml, buildTelegramRichMarkdown } from "./rich-message.js";

const BLANK_LINE_FILLER = "\u200B";

describe("buildTelegramRichMessage", () => {
  it("preserves visible blank lines in rich Markdown paragraphs", () => {
    const message = buildTelegramRichMarkdown(["First block", "", "Second block"].join("\n"));

    expect(message.html).toBe(`First block\n${BLANK_LINE_FILLER}\nSecond block`);
  });

  it("preserves visible blank lines in emoji work reports", () => {
    const message = buildTelegramRichMarkdown(
      ["✅ Výsledek: OK", "", "Co to znamená: OK", "", "☑️ Ověřeno: OK"].join("\n"),
    );

    expect(message.html).toBe(
      `✅ Výsledek: OK\n${BLANK_LINE_FILLER}\nCo to znamená: OK\n${BLANK_LINE_FILLER}\n☑️ Ověřeno: OK`,
    );
  });

  it("does not add blank-line fillers inside Markdown code blocks", () => {
    const message = buildTelegramRichMarkdown(["```", "line 1", "", "line 2", "```"].join("\n"));

    expect(message.html).toBe("<pre><code>line 1\n\nline 2\n</code></pre>");
  });

  it("preserves rich HTML blank lines without touching pre/code content", () => {
    const message = buildTelegramRichHtml(
      ["First block", "", "<pre><code>line 1", "", "line 2</code></pre>", "", "Second block"].join(
        "\n",
      ),
    );

    expect(message.html).toBe(
      `First block\n${BLANK_LINE_FILLER}\n<pre><code>line 1\n\nline 2</code></pre>\n${BLANK_LINE_FILLER}\nSecond block`,
    );
  });
});
