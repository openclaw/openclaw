// Telegram tests cover format plugin behavior.
import { describe, expect, it } from "vitest";
import {
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  markdownToTelegramRichHtml,
  renderTelegramHtmlText,
  sanitizeTelegramRichHtml,
  splitTelegramHtmlChunks,
  telegramHtmlToPlainTextFallback,
} from "./format.js";

describe("markdownToTelegramHtml", () => {
  it("handles core markdown-to-telegram conversions", () => {
    const cases = [
      [
        "renders basic inline formatting",
        "hi _there_ **boss** `code`",
        "hi <i>there</i> <b>boss</b> <code>code</code>",
      ],
      [
        "renders links as Telegram-safe HTML",
        "see [docs](https://example.com)",
        'see <a href="https://example.com">docs</a>',
      ],
      ["preserves Telegram HTML", "<b>yes</b>", "<b>yes</b>"],
      [
        "escapes unsupported raw HTML",
        "<script>nope</script>",
        "&lt;script&gt;nope&lt;/script&gt;",
      ],
      ["escapes unsafe characters", "a & b < c", "a &amp; b &lt; c"],
      ["renders paragraphs with blank lines", "first\n\nsecond", "first\n\nsecond"],
      ["renders lists without block HTML", "- one\n- two", "• one\n• two"],
      ["renders ordered lists with numbering", "2. two\n3. three", "2. two\n3. three"],
      ["flattens headings", "# Title", "Title"],
    ] as const;
    for (const [name, input, expected] of cases) {
      expect(markdownToTelegramHtml(input), name).toBe(expected);
    }
  });

  it("preserves supported Telegram HTML in stream markdown rendering", () => {
    const input = [
      "✉️ <b>Morning Email Rollup</b>",
      "",
      "<blockquote>✅ No important emails in the last 24 hours.</blockquote>",
      "",
      "<pre><code>oauth2: invalid_grant</code></pre>",
    ].join("\n");

    expect(markdownToTelegramHtml(input)).toBe(input);
    expect(
      markdownToTelegramChunks(input, 4096)
        .map((chunk) => chunk.html)
        .join(""),
    ).toBe(input);
  });

  it("preserves Telegram expandable blockquote HTML", () => {
    const input = "<blockquote expandable>hidden details</blockquote>";

    expect(markdownToTelegramHtml(input)).toBe(input);
    expect(renderTelegramHtmlText(input, { textMode: "html" })).toBe(input);
  });

  it("does not promote Telegram HTML tags inside code", () => {
    expect(markdownToTelegramHtml("`<b>literal</b>`")).toBe(
      "<code>&lt;b&gt;literal&lt;/b&gt;</code>",
    );
    expect(markdownToTelegramHtml("```\n<blockquote>literal</blockquote>\n```")).toBe(
      "<pre><code>&lt;blockquote&gt;literal&lt;/blockquote&gt;\n</code></pre>",
    );
  });

  it("keeps unsupported Telegram HTML variants escaped", () => {
    expect(markdownToTelegramHtml('<b class="x">bad</b>')).toBe('&lt;b class="x"&gt;bad&lt;/b&gt;');
    expect(markdownToTelegramHtml('<blockquote cite="x">bad</blockquote>')).toBe(
      '&lt;blockquote cite="x"&gt;bad&lt;/blockquote&gt;',
    );
    expect(markdownToTelegramHtml("<sup>1</sup>")).toBe("&lt;sup&gt;1&lt;/sup&gt;");
    expect(renderTelegramHtmlText('<b class="x">bad</b>', { textMode: "html" })).toBe(
      '&lt;b class="x"&gt;bad&lt;/b&gt;',
    );
  });

  it("preserves rich-only Telegram HTML tags on the rich path", () => {
    expect(markdownToTelegramRichHtml("<sup>1</sup>")).toBe("<sup>1</sup>");
  });

  it("preserves rich table, details, quote, checklist, anchor, and math HTML", () => {
    const input = [
      '<a name="top"></a>',
      "<h2>Plan</h2>",
      '<table bordered striped><caption>Scores</caption><thead><tr><th align="left">Name</th><th align="right" colspan="2">Total</th></tr></thead><tbody><tr><td>A</td><td align="right">1</td><td>2</td></tr></tbody></table>',
      "<details><summary>More</summary><p>Hidden</p></details>",
      "<aside>Pull quote<cite>Source</cite></aside>",
      '<ul><li><input type="checkbox" checked/>Done</li><li><input type="checkbox"/>Todo</li></ul>',
      '<p><a href="#top">Back</a> H<sub>2</sub>O E=mc<sup>2</sup> <mark>note</mark> <tg-spoiler>secret</tg-spoiler> <tg-math>E=mc^2</tg-math></p>',
      "<tg-math-block>\\int_0^1 x^2 dx</tg-math-block>",
    ].join("\n");

    expect(markdownToTelegramRichHtml(input)).toBe(input);
  });

  it("isolates rich media tags as blocks", () => {
    const html = markdownToTelegramRichHtml(
      'One <img src="https://example.com/a.jpg" alt="A"> two https://example.com/page',
    );

    expect(html).toContain(
      '\n\n<figure><img src="https://example.com/a.jpg" alt="A"/></figure>\n\n',
    );
    expect(html).toContain('<a href="https://example.com/page">https://example.com/page</a>');
    expect(html).not.toContain("&lt;img");
    expect(html).not.toContain('<a href="https://example.com/a.jpg">');
  });

  it("escapes rich media tags without supported http sources", () => {
    expect(markdownToTelegramRichHtml('<img src="logo.png" alt="Logo">')).toBe(
      '&lt;img src="logo.png" alt="Logo"&gt;',
    );
    expect(markdownToTelegramRichHtml('<audio src="data:audio/wav;base64,x"></audio>')).toBe(
      '&lt;audio src="data:audio/wav;base64,x"&gt;&lt;/audio&gt;',
    );
    expect(markdownToTelegramRichHtml('<video src="https://example.com/a.mp4"></video>')).toBe(
      '<figure><video src="https://example.com/a.mp4"></video></figure>',
    );
  });

  it("renders Markdown media blocks on the rich HTML fallback path", () => {
    expect(markdownToTelegramRichHtml('![Diagram](https://example.com/a.jpg "Caption")')).toBe(
      '<figure><img src="https://example.com/a.jpg" alt="Diagram"/><figcaption>Caption</figcaption></figure>',
    );
    expect(
      markdownToTelegramRichHtml('![A "quote"](https://cdn.example/img.png?token=a&expires=b)'),
    ).toBe(
      '<figure><img src="https://cdn.example/img.png?token=a&amp;expires=b" alt="A &quot;quote&quot;"/></figure>',
    );
    expect(markdownToTelegramRichHtml("![A > B](https://example.com/a.png)")).toBe(
      '<figure><img src="https://example.com/a.png" alt="A &gt; B"/></figure>',
    );
    expect(markdownToTelegramRichHtml("See ![Diagram](https://example.com/a.jpg).")).toBe(
      'See <a href="https://example.com/a.jpg">Diagram</a>.',
    );
    expect(markdownToTelegramRichHtml("```\n![](https://example.com/a.jpg)\n```")).toBe(
      "<pre><code>![](https://example.com/a.jpg)\n</code></pre>",
    );
  });

  it("renders rich tables and falls back when they exceed Telegram's column limit", () => {
    const table = (columns: number) =>
      [
        `| ${Array.from({ length: columns }, (_, index) => `H${index + 1}`).join(" | ")} |`,
        `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`,
        `| ${Array.from({ length: columns }, (_, index) => String(index + 1)).join(" | ")} |`,
      ].join("\n");

    expect(markdownToTelegramRichHtml(table(20))).toContain("<table>");
    expect(markdownToTelegramRichHtml(table(21))).toContain("<pre><code>");
    expect(markdownToTelegramRichHtml(table(2), { tableMode: "code" })).toContain("<pre><code>");
    expect(markdownToTelegramRichHtml(table(2), { tableMode: "code" })).not.toContain("<table>");
  });

  it("falls back over-wide raw rich HTML tables", () => {
    const cells = Array.from({ length: 21 }, (_, index) => `<td>C${index + 1}</td>`).join("");
    const html = `<table><caption>Wide</caption><tbody><tr>${cells}</tr></tbody></table>`;
    const sanitized = sanitizeTelegramRichHtml(html);

    expect(sanitized).toContain("<pre><code>Wide");
    expect(sanitized).toContain("C21");
    expect(sanitized).not.toContain("<table>");
  });

  it("clamps raw rich HTML table colspans before fallback", () => {
    const html = '<table><tbody><tr><td colspan="1000000000">x</td></tr></tbody></table>';
    const sanitized = sanitizeTelegramRichHtml(html);

    expect(sanitized).toContain("<pre><code>");
    expect(sanitized.length).toBeLessThan(300);
  });

  it("renders block-mode tables as code in legacy Telegram HTML", () => {
    const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";

    expect(markdownToTelegramHtml(table, { tableMode: "block" })).toBe(
      "<pre><code>| A | B |\n| --- | --- |\n| 1 | 2 |\n</code></pre>",
    );
  });

  it("preserves inline markdown inside rich table cells", () => {
    const html = markdownToTelegramRichHtml(
      "| Name | Link |\n| --- | --- |\n| **API** | [docs](https://example.com) |",
    );

    expect(html).toContain("<td><b>API</b></td>");
    expect(html).toContain('<td><a href="https://example.com">docs</a></td>');
  });

  it("does not auto-linkify bare URLs when entity detection is skipped", () => {
    expect(markdownToTelegramRichHtml("https://example.com", { skipEntityDetection: true })).toBe(
      "https://example.com",
    );
    expect(
      markdownToTelegramRichHtml("[docs](https://example.com)", { skipEntityDetection: true }),
    ).toBe('<a href="https://example.com">docs</a>');
  });

  it("keeps unsupported markdown link hrefs as visible text in rich HTML", () => {
    expect(
      markdownToTelegramRichHtml(
        "[scripts/yougile.py](/home/dankar/.openclaw/workspace-yougile/scripts/yougile.py#L41)",
      ),
    ).toBe("<code>scripts/yougile.py</code>");
    expect(markdownToTelegramRichHtml("[config](./openclaw.json)")).toBe("config");
    expect(markdownToTelegramRichHtml("[docs](https://example.com/docs)")).toBe(
      '<a href="https://example.com/docs">docs</a>',
    );
    expect(markdownToTelegramRichHtml("[user](tg://user?id=123)")).toBe(
      '<a href="tg://user?id=123">user</a>',
    );
    expect(markdownToTelegramRichHtml("[support](mailto:user@example.com)")).toBe(
      '<a href="mailto:user@example.com">support</a>',
    );
    expect(markdownToTelegramRichHtml("[call](tel:+123456789)")).toBe(
      '<a href="tel:+123456789">call</a>',
    );
    expect(markdownToTelegramRichHtml("[back](#top)")).toBe('<a href="#top">back</a>');
  });

  it("preserves Markdown heading levels in rich HTML", () => {
    expect(markdownToTelegramRichHtml("# Title\n\n### Detail")).toBe(
      "<h1>Title</h1>\n\n<h3>Detail</h3>",
    );
  });

  it("normalizes raw code language HTML without leaking tags", () => {
    const commandBlock = '<code class="language-text">/queue followup debounce:0\n</code>';

    expect(markdownToTelegramHtml(commandBlock)).toBe("<code>/queue followup debounce:0\n</code>");
    expect(
      markdownToTelegramHtml('<pre><code class="language-python">print(1)\n</code></pre>'),
    ).toBe('<pre><code class="language-python">print(1)\n</code></pre>');
  });

  it("renders blockquotes as native Telegram blockquote tags", () => {
    const res = markdownToTelegramHtml("> Quote");
    expect(res).toContain("<blockquote>");
    expect(res).toContain("Quote");
    expect(res).toContain("</blockquote>");
  });

  it("renders blockquotes with inline formatting", () => {
    const res = markdownToTelegramHtml("> **bold** quote");
    expect(res).toContain("<blockquote>");
    expect(res).toContain("<b>bold</b>");
    expect(res).toContain("</blockquote>");
  });

  it("renders multiline blockquotes as a single Telegram blockquote", () => {
    const res = markdownToTelegramHtml("> first\n> second");
    expect(res).toBe("<blockquote>first\nsecond</blockquote>");
  });

  it("renders separated quoted paragraphs as distinct blockquotes", () => {
    const res = markdownToTelegramHtml("> first\n\n> second");
    expect(res).toContain("<blockquote>first");
    expect(res).toContain("<blockquote>second</blockquote>");
    expect(res.match(/<blockquote>/g)).toHaveLength(2);
  });

  it("renders fenced code block languages for Telegram native copy buttons", () => {
    const res = markdownToTelegramHtml('```bash\necho "hello"\n```');
    expect(res).toBe('<pre><code class="language-bash">echo "hello"\n</code></pre>');
  });

  it("properly nests overlapping bold and autolink (#4071)", () => {
    const res = markdownToTelegramHtml("**start https://example.com** end");
    expect(res).toMatch(
      /<b>start <a href="https:\/\/example\.com">https:\/\/example\.com<\/a><\/b> end/,
    );
  });

  it("properly nests link inside bold", () => {
    const res = markdownToTelegramHtml("**bold [link](https://example.com) text**");
    expect(res).toBe('<b>bold <a href="https://example.com">link</a> text</b>');
  });

  it("properly nests bold wrapping a link with trailing text", () => {
    const res = markdownToTelegramHtml("**[link](https://example.com) rest**");
    expect(res).toBe('<b><a href="https://example.com">link</a> rest</b>');
  });

  it("properly nests bold inside a link", () => {
    const res = markdownToTelegramHtml("[**bold**](https://example.com)");
    expect(res).toBe('<a href="https://example.com"><b>bold</b></a>');
  });

  it("wraps punctuated file references in code tags", () => {
    const res = markdownToTelegramHtml("See README.md. Also (backup.sh).");
    expect(res).toContain("<code>README.md</code>.");
    expect(res).toContain("(<code>backup.sh</code>).");
  });

  it("renders spoiler tags", () => {
    const res = markdownToTelegramHtml("the answer is ||42||");
    expect(res).toBe("the answer is <tg-spoiler>42</tg-spoiler>");
  });

  it("renders spoiler with nested formatting", () => {
    const res = markdownToTelegramHtml("||**secret** text||");
    expect(res).toBe("<tg-spoiler><b>secret</b> text</tg-spoiler>");
  });

  it("preserves spacing between Telegram bullet blocks and following numbered sections", () => {
    const input = [
      "2. Main invariants:",
      "",
      "  • Raw Log is source of truth.",
      "  • Autonomy starts only with report/draft.",
      "3. Cognee is a candidate:",
      "",
      "  • bake-off first;",
      "  • decide keep/adopt/hybrid later.",
      "4. Project Flow slices:",
    ].join("\n");

    const res = markdownToTelegramHtml(input, { wrapFileRefs: false });

    expect(res).toContain("report/draft.\n\n3. Cognee");
    expect(res).toContain("keep/adopt/hybrid later.\n\n4. Project");
  });

  it("preserves Telegram list boundary spacing in chunked rendering", () => {
    const input = [
      "2. Main invariants:",
      "",
      "  • Raw Log is source of truth.",
      "  • Autonomy starts only with report/draft.",
      "3. Cognee is a candidate:",
    ].join("\n");

    const res = markdownToTelegramChunks(input, 4096)
      .map((chunk) => chunk.html)
      .join("");

    expect(res).toContain("report/draft.\n\n3. Cognee");
  });

  it("does not insert Telegram list boundary spacing inside fenced code", () => {
    const input = ["```", "  • literal bullet", "3. literal number", "```"].join("\n");

    const res = markdownToTelegramHtml(input, { wrapFileRefs: false });

    expect(res).toBe("<pre><code>  • literal bullet\n3. literal number\n</code></pre>");
  });

  it("does not insert Telegram list boundary spacing inside indented code", () => {
    const input = ["    • literal bullet", "    3. literal number"].join("\n");

    const res = markdownToTelegramHtml(input, { wrapFileRefs: false });
    const chunks = markdownToTelegramChunks(input, 4096)
      .map((chunk) => chunk.html)
      .join("");

    expect(res).toBe("<pre><code>• literal bullet\n3. literal number\n</code></pre>");
    expect(chunks).toBe(res);
  });

  it("does not treat single pipe as spoiler", () => {
    const res = markdownToTelegramHtml("(￣_￣|) face");
    expect(res).not.toContain("tg-spoiler");
    expect(res).toContain("|");
  });

  it("does not treat unpaired || as spoiler", () => {
    const res = markdownToTelegramHtml("before || after");
    expect(res).not.toContain("tg-spoiler");
    expect(res).toContain("||");
  });

  it("keeps valid spoiler pairs when a trailing || is unmatched", () => {
    const res = markdownToTelegramHtml("||secret|| trailing ||");
    expect(res).toContain("<tg-spoiler>secret</tg-spoiler>");
    expect(res).toContain("trailing ||");
  });

  it("splits long multiline html text without breaking balanced tags", () => {
    const chunks = splitTelegramHtmlChunks(`<b>${"A\n".repeat(2500)}</b>`, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(chunks[0]).toMatch(/^<b>[\s\S]*<\/b>$/);
    expect(chunks[1]).toMatch(/^<b>[\s\S]*<\/b>$/);
  });

  it("does not synthesize closing tags for rich void tags when chunking html", () => {
    const chunks = splitTelegramHtmlChunks(
      `<figure><img src="https://example.com/a.jpg"></figure><ul><li><input type="checkbox" checked>${"A".repeat(80)}</li></ul>`,
      64,
    );

    expect(chunks.join("")).not.toContain("</img>");
    expect(chunks.join("")).not.toContain("</input>");
  });

  it("fails loudly when a leading entity cannot fit inside a chunk", () => {
    expect(() => splitTelegramHtmlChunks(`A&amp;${"B".repeat(20)}`, 4)).toThrow(/leading entity/i);
  });

  it("treats malformed leading ampersands as plain text when chunking html", () => {
    const chunks = splitTelegramHtmlChunks(`&${"A".repeat(5000)}`, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
  });

  it("derives readable plain text from Telegram HTML fallback markup", () => {
    const html = [
      'Created: <a href="https://example.com/a?x=1&amp;y=2">Task &amp; One</a>',
      "<code>file.md</code>",
      "<br>",
      '<a href="https://example.com/same">https://example.com/same</a>',
      "<b>done</b>",
    ].join(" ");

    expect(telegramHtmlToPlainTextFallback(html)).toBe(
      "Created: Task & One (https://example.com/a?x=1&y=2) file.md \n https://example.com/same done",
    );
  });

  it("preserves escaped angle-bracket text in Telegram HTML fallback links", () => {
    expect(
      telegramHtmlToPlainTextFallback(
        '<a href="https://example.com/task?id=1&amp;kind=bug">Task &lt;id&gt;</a>',
      ),
    ).toBe("Task <id> (https://example.com/task?id=1&kind=bug)");
  });

  it("preserves table cell boundaries in Telegram HTML fallback text", () => {
    expect(
      telegramHtmlToPlainTextFallback(
        "<table><thead><tr><th>Name</th><th>Age</th></tr></thead><tbody><tr><td>Alice</td><td>30</td></tr></tbody></table>",
      ),
    ).toBe("Name | Age\nAlice | 30");
  });

  it("fails loudly when tag overhead leaves no room for text", () => {
    expect(() => splitTelegramHtmlChunks("<b><i><u>x</u></i></b>", 10)).toThrow(/tag overhead/i);
  });

  it("does not split an astral char across the chunk boundary", () => {
    // Emoji surrogate pair straddles index 10 (limit): high at 9, low at 10.
    const input = `${"A".repeat(9)}😀${"B".repeat(20)}`;
    const chunks = splitTelegramHtmlChunks(input, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(input);
    for (const chunk of chunks) {
      expect(containsLoneSurrogate(chunk)).toBe(false);
    }
  });

  it("keeps an astral char whole when a positive limit starts on its pair", () => {
    expect(splitTelegramHtmlChunks("A😀B", 1)).toEqual(["A", "😀", "B"]);
  });

  it("keeps astral chars whole in rendered Markdown chunks", () => {
    const chunks = markdownToTelegramChunks("A😀B", 1);

    expect(chunks.map((chunk) => chunk.text)).toEqual(["A", "😀", "B"]);
    for (const chunk of chunks) {
      expect(containsLoneSurrogate(chunk.html)).toBe(false);
      expect(containsLoneSurrogate(chunk.text)).toBe(false);
    }
  });
});

function containsLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isHigh) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (isLow) {
      return true;
    }
  }
  return false;
}
