import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { wrapFileReferencesInHtml } from "./format-html-text.js";
import {
  markdownToTelegramChunks,
  markdownToTelegramHtml,
  renderTelegramHtmlText,
  splitTelegramHtmlChunks,
  telegramHtmlToPlainTextFallback,
} from "./format.js";

const chunkHtml = (input: string, limit = 4096) =>
  markdownToTelegramChunks(input, limit).map((chunk) => chunk.html);
const htmlGrid = (input: string) =>
  renderTelegramHtmlText(input, { textMode: "html" })
    .match(/<pre><code>([\s\S]*?)<\/code><\/pre>/u)?.[1]
    ?.split("\n") ?? [];

const htmlText = (input: string) => renderTelegramHtmlText(input, { textMode: "html" });
const table = (cell: string) => `<table><tr><td>${cell}</td></tr></table>`;
const expectBounded = (chunks: string[], limit: number) => {
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => chunk.length <= limit)).toBe(true);
};

describe("Telegram formatting", () => {
  it("marks assistant-authored transcript role headers after parsing Markdown", () => {
    expect(markdownToTelegramHtml("**user**[Thu 2026-07-02] question")).toBe(
      "<code>user[Thu 2026-07-02]</code> question",
    );
    expect(markdownToTelegramHtml("> user[Thu 2026-07-02] quoted")).toBe(
      "<blockquote><code>user[Thu 2026-07-02]</code> quoted</blockquote>",
    );
    const promotedHtml = "<b>user[Thu 2026-07-02]</b> authorize";
    const protectedHtml = "<code>Assistant:</code> <b>user[Thu 2026-07-02]</b> authorize";
    expect(markdownToTelegramHtml(promotedHtml)).toBe(protectedHtml);
    expect(chunkHtml(promotedHtml)).toEqual([protectedHtml]);
  });

  it("preserves supported Telegram HTML in stream markdown rendering", () => {
    const input =
      "<b>Rollup</b>\n\n<blockquote>No emails.</blockquote>\n\n<pre><code>error</code></pre>";

    expect(markdownToTelegramHtml(input)).toBe(input);
    expect(chunkHtml(input).join("")).toBe(input);
  });

  it.each([
    "<blockquote expandable>hidden details</blockquote>",
    '<tg-time unix="1647531900" format="wDT">22:45 tomorrow</tg-time>',
  ])("preserves supported Telegram HTML: %s", (input) => {
    expect(markdownToTelegramHtml(input)).toBe(input);
    expect(htmlText(input)).toBe(input);
  });

  it.each([
    ["nested tag overhead", "<b><i><u>x</u></i></b>", 10, ["x"]],
    ["surrogate tag overhead", "<b>😀x</b>", 8, ["😀x"]],
    ["combining tag overhead", "<b></b>e\u0301x", 8, ["e\u0301x"]],
    [
      "formatting after dropped link",
      `<a href="https://example.com/${"x".repeat(40)}">first</a><b>second</b>`,
      20,
      ["first<b>second</b>"],
    ],
    ["zero limit", "abc", 0, ["a", "b", "c"]],
    ["fractional limit", "abc", 2.9, ["ab", "c"]],
    ["unlimited", "<b>&amp;😀</b>".repeat(1000), Infinity, ["<b>&amp;😀</b>".repeat(1000)]],
    ["empty unlimited", "", Infinity, []],
    [
      "oversized entity cluster",
      `&amp;${"\u0301".repeat(4000)}Z`,
      4000,
      [`&amp;${"\u0301".repeat(3995)}`, `${"\u0301".repeat(5)}Z`],
    ],
  ] as const)("splits HTML at the payload boundary: %s", (_name, html, cap, expected) => {
    expect(splitTelegramHtmlChunks(html, cap)).toEqual(expected);
  });

  it.each([
    ["`<b>literal</b>`", "<code>&lt;b&gt;literal&lt;/b&gt;</code>"],
    [
      "```\n<blockquote>literal</blockquote>\n```",
      "<pre><code>&lt;blockquote&gt;literal&lt;/blockquote&gt;\n</code></pre>",
    ],
    ['<b class="x">bad</b>', '&lt;b class="x"&gt;bad&lt;/b&gt;'],
    ['<blockquote cite="x">bad</blockquote>', '&lt;blockquote cite="x"&gt;bad&lt;/blockquote&gt;'],
    ["<sup>1</sup>", "&lt;sup&gt;1&lt;/sup&gt;"],
    ['<tg-time unix="-1">bad</tg-time>', '&lt;tg-time unix="-1"&gt;bad&lt;/tg-time&gt;'],
    [
      '<code class="language-text">/queue followup debounce:0\n</code>',
      "<code>/queue followup debounce:0\n</code>",
    ],
    [
      '<pre><code class="language-python">print(1)\n</code></pre>',
      '<pre><code class="language-python">print(1)\n</code></pre>',
    ],
    ['```bash\necho "hello"\n```', '<pre><code class="language-bash">echo "hello"\n</code></pre>'],
    // #4071: overlapping bold and autolink ranges must nest, not cross.
    [
      "**start https://example.com** end",
      '<b>start <a href="https://example.com">https://example.com</a></b> end',
    ],
  ])("renders code, escaping, and nested formatting: %s", (input, expected) => {
    expect(markdownToTelegramHtml(input)).toBe(expected);
    if (input.startsWith('<b class="x">')) {
      expect(htmlText(input)).toBe(expected);
    }
  });

  it("aligns Unicode cells in raw HTML table fallbacks", () => {
    const input = [
      "<table><tr><th>Name</th><th>Mark</th><th>Note</th></tr>",
      '<tr><td colspan="2">小明</td><td>✅</td></tr>',
      "<tr><td>cafe\u0301</td><td>👨‍👩‍👧</td><td>©️</td></tr>",
      "</table>",
    ].join("");

    const grid = htmlGrid(input);
    expect(grid.length).toBeGreaterThan(0);
    expect(new Set(grid.map((line) => stringWidth(line))).size).toBe(1);
  });

  it("does not allocate a table cell for zero-width spaces", () => {
    const [withInvisible, reference] = htmlGrid(
      "<table><tr><td>A\u200BB</td></tr><tr><td>AB</td></tr></table>",
    );
    expect(withInvisible?.replace("\u200B", "")).toBe(reference);
  });

  it.each(["code", "pre"])(
    "keeps only the table inside %s escaped between rendered tables",
    (tag) => {
      expect(htmlText(`${table("A")}<${tag}>${table("B")}</${tag}>${table("C")}`)).toBe(
        `<pre><code>| A   |</code></pre>\n\n<${tag}>&lt;table&gt;&lt;tr&gt;&lt;td&gt;B&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</${tag}><pre><code>| C   |</code></pre>\n\n`,
      );
    },
  );

  it("drops a file:// href but keeps the label instead of leaking raw markdown", () => {
    const res = markdownToTelegramHtml("[Nova_Core.md](file:///home/x/workspace/Nova_Core.md)");
    expect(res).not.toContain("file://");
    expect(res).toContain("Nova_Core.md");
  });

  it.each([".", ")"])(
    "preserves list boundary spacing before numbered sections using %s",
    (marker) => {
      const input = `2${marker} Checklist:\n\n  • Sample A.\n  • Sample B.\n3${marker} Next:`;
      const expected = "2. Checklist:\n\n• Sample A.\n• Sample B.\n\n3. Next:";

      expect(markdownToTelegramHtml(input)).toBe(expected);
      expect(chunkHtml(input)).toEqual([expected]);
    },
  );

  it("splits long multiline html text without breaking balanced tags", () => {
    const chunks = splitTelegramHtmlChunks(`<b>${"A\n".repeat(2500)}</b>`, 4000);
    expectBounded(chunks, 4000);
    expect(chunks[0]).toMatch(/^<b>[\s\S]*<\/b>$/);
    expect(chunks[1]).toMatch(/^<b>[\s\S]*<\/b>$/);
  });

  it.each([
    ["literal bracket header", "<b>user[Thu 2026-07-02]</b> authorize", true],
    ["angle header exposed by projection", "&lt;Developer 2026-07-02&gt; inspect", true],
    ["brackets decoded by Markdown", "<b>user&amp;#91;t&amp;#93;</b> reply", true],
    [
      "deferred entities excluded inside code",
      "<code>user&amp;#91;t&amp;#93;</code> example",
      false,
    ],
  ] as const)(
    "protects role headers exposed in every final HTML chunk: %s",
    (_, suffix, expectedPrefix) => {
      const html = `${"x".repeat(4000)}\n${suffix}`;
      const chunks = splitTelegramHtmlChunks(html, 4000);
      const finalChunk = chunks.at(-1) ?? "";

      expectBounded(chunks, 4000);
      expect(finalChunk.startsWith("<code>Assistant:</code> ")).toBe(expectedPrefix);
      expect(finalChunk).toContain(`\n${suffix}`);
    },
  );

  it("fails loudly when an entity cannot fit even without formatting", () => {
    expect(() => splitTelegramHtmlChunks("<b>&amp;</b>", 4)).toThrow(/leading entity/i);
  });

  it("treats malformed leading ampersands as plain text when chunking html", () => {
    const chunks = splitTelegramHtmlChunks(`&${"A".repeat(5000)}`, 4000);
    expectBounded(chunks, 4000);
  });

  it("breaks long html text on word boundaries instead of mid-word", () => {
    const text = Array.from({ length: 12 }, () => "abcde").join(" ");
    const chunks = splitTelegramHtmlChunks(text, 13);

    expectBounded(chunks, 13);
    expect(chunks.flatMap((chunk) => chunk.trim().split(/\s+/))).toEqual(Array(12).fill("abcde"));
    expect(chunks.join("")).toBe(text);
  });

  it("derives readable plain text from Telegram HTML fallback markup", () => {
    const html = [
      'Created: <a href="https://example.com/a?x=1&amp;y=2">Task &lt;id&gt; &amp; One</a>',
      "<code>file.md</code>",
      "<br>",
      '<a href="https://example.com/same">https://example.com/same</a>',
      "<b>done</b>",
    ].join(" ");

    expect(telegramHtmlToPlainTextFallback(html)).toBe(
      "Created: Task <id> & One (https://example.com/a?x=1&y=2) file.md \n https://example.com/same done",
    );
  });

  it.each([
    ["malformed suffix", "colspan=2x", "Alice | 30"],
    ["numeric data attribute", "data-colspan=9 colspan=2", "Alice |  | 30"],
  ])("parses only complete decimal fallback colspans: %s", (_label, attrs, expected) => {
    expect(
      telegramHtmlToPlainTextFallback(`<table><tr><td ${attrs}>Alice</td><td>30</td></tr></table>`),
    ).toBe(expected);
  });

  it.each([
    ["x &#xD800; y", "x &#xD800; y"],
    ["x &#55296; y", "x &#55296; y"],
    ["x &#xDFFF; y", "x &#xDFFF; y"],
    ["x &#x1F600; &#128512; y", "x 😀 😀 y"],
    ["first<b>second</b>", "firstsecond"],
  ])("projects fallback text without invalid entities or markup: %s", (input, expected) => {
    expect(telegramHtmlToPlainTextFallback(input)).toBe(expected);
  });

  it("keeps a family emoji whole when the cap lands inside its ZWJ sequence", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
    const prefix = "a".repeat(3998);
    const input = `${prefix}${family}Z`;
    const expected = [prefix, `${family}Z`];
    expect(splitTelegramHtmlChunks(input, 4000)).toEqual(expected);
    expect(markdownToTelegramChunks(input, 4000).map((chunk) => chunk.text)).toEqual(expected);
  });

  it.each([
    ["literal family", 3991, "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}Z"],
    ["entity-encoded flag", 3984, "&#x1F1FA;&#x1F1F8;Z"],
  ] as const)(
    "moves a leading %s to a fresh chunk after closing tags",
    (_, prefixLength, suffix) => {
      const prefix = `<i>${"a".repeat(prefixLength)}</i>`;
      expect(splitTelegramHtmlChunks(`${prefix}${suffix}`, 4000)).toEqual([prefix, suffix]);
    },
  );

  it("keeps a leading cluster whole when a preferred word break falls inside it", () => {
    const cluster = "\u0600 \u0301";
    const input = `${cluster}abc`;
    const chunks = splitTelegramHtmlChunks(input, 4);
    expect(chunks.join("")).toBe(input);
    expect(chunks.every((chunk) => chunk.length <= 4)).toBe(true);
    expect(chunks[0]).toContain(cluster);
  });

  it.each([
    [3995, "&amp;\u0301tail", 4000],
    [4090, "&#x65;&#769;", 4096],
  ] as const)("keeps entity clusters whole at prefix length %s", (length, cluster, limit) => {
    const prefix = "a".repeat(length);
    expect(splitTelegramHtmlChunks(`${prefix}${cluster}`, limit)).toEqual([prefix, cluster]);
  });

  it.each(["&unknown;", "&#xD800;"])(
    "keeps an opaque entity with its Prepend prefix and trailing combining mark: %s",
    (entity) => {
      const cluster = `\u0600${entity}\u0301`;
      expect(splitTelegramHtmlChunks(`A${cluster}B`, cluster.length)).toEqual(["A", cluster, "B"]);
    },
  );

  it("rejects NaN instead of repeatedly emitting chunks without consuming input", () => {
    expect(() => splitTelegramHtmlChunks("<b>abcdef</b>", Number.NaN)).toThrow(TypeError);
  });

  it("keeps a Markdown table visible between prose in legacy HTML", () => {
    const input = "Before\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter";
    const html = markdownToTelegramHtml(input, { tableMode: "block" });
    expect(html).toContain("<pre><code>| A   | B   |\n| --- | --- |\n| 1   | 2   |\n</code></pre>");
    expect(html).toContain("Before");
    expect(html).toContain("After");
    const chunks = markdownToTelegramChunks(input, 4096, { tableMode: "block" });
    expect(chunks.map((chunk) => chunk.html)).toEqual([html]);
    expect(chunks[0]?.text).toContain("| 1   | 2   |");
  });

  it.each([".", ")"])(
    "does not insert list spacing inside a longer code fence using %s",
    (marker) => {
      const input = `\`\`\`\`\n\`\`\`\n• literal bullet\n3${marker} literal number\n\`\`\`\``;
      const expected =
        "<pre><code>```\n• literal bullet\n3" + marker + " literal number\n</code></pre>";
      expect(markdownToTelegramHtml(input, { wrapFileRefs: false })).toBe(expected);
      expect(chunkHtml(input)).toEqual([expected]);
    },
  );
});

describe("file references", () => {
  it("does not wrap in HTML mode (trusts caller markup)", () => {
    expect(htmlText("Check README.md")).toBe("Check README.md");
    expect(renderTelegramHtmlText("Check README.md")).toContain("<code>README.md</code>");
  });

  it("preserves authored file-style links in chunked output", () => {
    expect(markdownToTelegramChunks("README.md [README.md](https://README.md)", 4096)).toEqual([
      {
        html: '<code>README.md</code> <a href="https://README.md">README.md</a>',
        text: "README.md README.md",
      },
    ]);
  });

  it("preserves formatting while splitting at word boundaries", () => {
    const input = "**alpha <<**";
    const chunks = markdownToTelegramChunks(input, 13);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe("alpha <<");
    expect(chunks[0]?.text).toBe("alpha ");
    for (const chunk of chunks) {
      expect(chunk.html.length).toBeLessThanOrEqual(13);
      expect(chunk.html.startsWith("<b>")).toBe(true);
      expect(chunk.html.endsWith("</b>")).toBe(true);
    }
  });

  it("does not rely on monotonic html length for sliced file refs", () => {
    const input = "README.md<";
    const chunks = markdownToTelegramChunks(input, 22);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(input);
    expect(chunks[0]?.text).toBe("README.md");
    expect(chunks[0]?.html).toBe("<code>README.md</code>");
    for (const chunk of chunks) {
      expect(chunk.html.length).toBeLessThanOrEqual(22);
    }
  });

  it("keeps the longest fitting prefix when a longer token stops looking like a file ref", () => {
    const input = `${"<".repeat(995)}docs/x.mdbar${"<".repeat(1001)}`;
    const chunks = markdownToTelegramChunks(input, 4000);
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      `${"<".repeat(995)}docs/x.mdbar<<`,
      "<".repeat(999),
    ]);
    expect(chunks.map((chunk) => chunk.html.length)).toEqual([4000, 3996]);
  });

  it("handles malformed HTML with stray closing tags (negative depth)", () => {
    expect(wrapFileReferencesInHtml("</code>README.md<code>inside</code> after.md")).toBe(
      "</code><code>README.md</code><code>inside</code> <code>after.md</code>",
    );
  });

  it.each([
    "<code>R&D.md</code>",
    '<a href="https://example.com">R&D.md</a>',
    '<a href="http://example.com/R&D.md">link</a>',
    '<img src="logo/R&D.md" alt="R&D.md">',
  ])("does not wrap orphaned TLD fragments in protected HTML: %s", (input) => {
    expect(wrapFileReferencesInHtml(input)).toBe(input);
  });

  it("handles multiple orphaned TLDs with HTML tags (offset stability)", () => {
    const input = '<a href="http://A.md">link</a> B.md <span title="C.sh">text</span> D.py';
    expect(wrapFileReferencesInHtml(input)).toBe(
      '<a href="http://A.md">link</a> <code>B.md</code> <span title="C.sh">text</span> <code>D.py</code>',
    );
  });

  it.each([
    ["compact", "<ul><li>Hero image</li><li>Countdown</li></ul>", "• Hero image\n• Countdown"],
    [
      "nested",
      "<ol><li>Parent<ul><li>Child</li></ul></li><li>Next</li></ol>",
      "1. Parent\n  • Child\n2. Next",
    ],
    [
      "checkbox attributes",
      `<ol start='3'><li>First</li><li><input type='checkbox' checked/>Done</li><li><input type=checkbox />Pending</li><li>Last</li></ol>`,
      "3. First\n[x] Done\n[ ] Pending\n6. Last",
    ],
    [
      "quoted angle brackets and inline formatting",
      `<ul><li><b>Scope</b></li><li><input title="a > b" type=checkbox checked/>Done</li></ul><hr/><aside>Read <a href="https://example.test">more</a></aside>`,
      '• <b>Scope</b>\n[x] Done\n<blockquote>Read <a href="https://example.test">more</a></blockquote>',
    ],
    [
      "literal HTML code",
      "<pre><code><ul><li>literal</li></ul></code></pre>",
      "<pre><code>&lt;ul&gt;&lt;li&gt;literal&lt;/li&gt;&lt;/ul&gt;</code></pre>",
    ],
    ["escaped divider", "Use &lt;hr/&gt; here", "Use &lt;hr/&gt; here"],
    [
      "escaped list and aside examples",
      "<ul><li>&lt;ul&gt;&lt;li&gt;literal&lt;/li&gt;&lt;/ul&gt;</li></ul><aside>&lt;aside&gt;literal&lt;/aside&gt;</aside>",
      "• &lt;ul&gt;&lt;li&gt;literal&lt;/li&gt;&lt;/ul&gt;\n<blockquote>&lt;aside&gt;literal&lt;/aside&gt;</blockquote>",
    ],
  ])("renders %s captions without leaking rich blocks", (_name, input, expected) => {
    for (const textMode of ["html", "markdown"] as const) {
      expect(renderTelegramHtmlText(input, { textMode, downgradeRichPromptTags: true })).toBe(
        expected,
      );
    }
  });

  it.each([
    [String.raw`Use \<hr/> here`, "Use &lt;hr/&gt; here"],
    [String.raw`Use \\<hr/> here`, String.raw`Use \ here`],
    [
      String.raw`\<ul>\<li>literal\</li>\</ul> \<aside>quote\</aside>`,
      "&lt;ul&gt;&lt;li&gt;literal&lt;/li&gt;&lt;/ul&gt; &lt;aside&gt;quote&lt;/aside&gt;",
    ],
  ])("preserves Markdown escape parity in captions: %s", (input, expected) => {
    expect(renderTelegramHtmlText(input, { downgradeRichPromptTags: true })).toBe(expected);
  });

  it("downgrades Markdown captions without changing literal code or non-caption rendering", () => {
    const input = "<ul><li>**Scope**</li><li>Next</li></ul>\n\n`<li>literal</li>`";
    const html = renderTelegramHtmlText(input, { downgradeRichPromptTags: true });
    expect(html).toBe("• <b>Scope</b>\n• Next\n\n<code>&lt;li&gt;literal&lt;/li&gt;</code>");
    expect(renderTelegramHtmlText(input)).toContain("&lt;ul&gt;");
    expect(
      renderTelegramHtmlText("```html\n<ul><li>literal</li></ul>\n```", {
        downgradeRichPromptTags: true,
      }),
    ).toBe(
      '<pre><code class="language-html">&lt;ul&gt;&lt;li&gt;literal&lt;/li&gt;&lt;/ul&gt;\n</code></pre>',
    );
    for (const textMode of ["html", "markdown"] as const) {
      const plain = "A plain caption  \n";
      expect(renderTelegramHtmlText(plain, { textMode, downgradeRichPromptTags: true })).toBe(
        renderTelegramHtmlText(plain, { textMode }),
      );
    }
  });
});
