import { describe, expect, it } from "vitest";
import { markdownToStory, type Story } from "./story.js";

type Block = Extract<Story[number], { block: unknown }>["block"];
type Listing = Extract<Block, { listing: unknown }>["listing"];
type List = Extract<Listing, { list: unknown }>["list"];

function list(type: List["type"], items: Listing[], contents: List["contents"] = []): Listing {
  return { list: { type, contents, items } };
}

function listStory(type: List["type"], items: Listing[]): Story {
  return [{ block: { listing: list(type, items) } }];
}

const listRenderingFixtures = [
  {
    name: "unordered markers become one native unordered listing",
    markdown: "- alpha\n- **beta**\n- [site](https://example.com)",
    expected: listStory("unordered", [
      { item: ["alpha"] },
      { item: [{ bold: ["beta"] }] },
      { item: [{ link: { href: "https://example.com", content: "site" } }] },
    ]),
  },
  {
    name: "task markers become native task inlines inside a task listing",
    markdown: "- [ ] todo\n- [x] **done**",
    expected: listStory("tasklist", [
      { item: [{ task: { checked: false, content: ["todo"] } }] },
      { item: [{ task: { checked: true, content: [{ bold: ["done"] }] } }] },
    ]),
  },
  {
    name: "nested ordered items stay recursive under their unordered parent",
    markdown: "- parent\n  1. first\n  2. second\n- sibling",
    expected: listStory("unordered", [
      list("ordered", [{ item: ["first"] }, { item: ["second"] }], ["parent"]),
      { item: ["sibling"] },
    ]),
  },
  {
    name: "mixed task and plain children stay in their nested bullet list",
    markdown: "- parent\n  - [ ] todo\n  - note\n- sibling",
    expected: listStory("unordered", [
      list(
        "unordered",
        [{ item: [{ task: { checked: false, content: ["todo"] } }] }, { item: ["note"] }],
        ["parent"],
      ),
      { item: ["sibling"] },
    ]),
  },
  {
    name: "empty bullet items stay inside their native listing",
    markdown: "- first\n-\n- third",
    expected: listStory("unordered", [{ item: ["first"] }, { item: [] }, { item: ["third"] }]),
  },
];

describe("markdownToStory inline formatting", () => {
  it.each([
    {
      markdown: "**bold** __bold__ *italic* _italic_ ~~strike~~ `code`",
      inline: [
        { bold: ["bold"] },
        " ",
        { bold: ["bold"] },
        " ",
        { italics: ["italic"] },
        " ",
        { italics: ["italic"] },
        " ",
        { strike: ["strike"] },
        " ",
        { "inline-code": "code" },
      ],
    },
    {
      markdown: "**outer *inner* text**",
      inline: [{ bold: ["outer ", { italics: ["inner"] }, " text"] }],
    },
    {
      markdown: "~zod [site](https://example.com)",
      inline: [{ ship: "~zod" }, " ", { link: { href: "https://example.com", content: "site" } }],
    },
    {
      markdown: "See [math](https://en.wikipedia.org/wiki/Function_(mathematics))!",
      inline: [
        "See ",
        { link: { href: "https://en.wikipedia.org/wiki/Function_(mathematics)", content: "math" } },
        "!",
      ],
    },
    {
      markdown: "[nested](https://example.com/a(b(c(d)e)f))",
      inline: [{ link: { href: "https://example.com/a(b(c(d)e)f)", content: "nested" } }],
    },
    {
      markdown: "https://example.com",
      inline: [{ link: { href: "https://example.com", content: "https://example.com" } }],
    },
    { markdown: "_word_suffix *unfinished", inline: ["_word_suffix *unfinished"] },
  ])("renders %j without losing literal text or nested styles", ({ markdown, inline }) => {
    expect(markdownToStory(markdown)).toEqual([{ inline }]);
  });

  it.each([
    "https://example.com/diagram.png",
    "https://example.com/diagram_(final).png",
    "https://example.com/a(b(c(d)e)f).png",
  ])("hoists an image with its complete destination %s", (url) => {
    expect(markdownToStory(`![diagram](${url})`)).toEqual([
      {
        block: {
          image: { src: url, alt: "diagram", height: 0, width: 0 },
        },
      },
    ]);
  });

  it("links a bare URL that follows text", () => {
    expect(markdownToStory("Docs: see https://docs.example.com/guide for details")).toEqual([
      {
        inline: [
          "Docs: see ",
          {
            link: {
              href: "https://docs.example.com/guide",
              content: "https://docs.example.com/guide",
            },
          },
          " for details",
        ],
      },
    ]);
  });

  it("keeps sentence punctuation after a bare URL out of the link", () => {
    const link = { link: { href: "https://example.com/a", content: "https://example.com/a" } };
    expect(markdownToStory("see https://example.com/a. Or (https://example.com/a)!")).toEqual([
      { inline: ["see ", link, ". Or (", link, ")!"] },
    ]);
  });

  it("keeps balanced parentheses inside a bare URL", () => {
    const url = "https://en.wikipedia.org/wiki/Function_(mathematics)";
    const link = { link: { href: url, content: url } };
    expect(markdownToStory(`see ${url}. Or (${url})!`)).toEqual([
      { inline: ["see ", link, ". Or (", link, ")!"] },
    ]);
  });

  it("keeps nested balanced parentheses inside a bare URL", () => {
    const url = "https://example.com/a(b(c)d)";
    const link = { link: { href: url, content: url } };
    expect(markdownToStory(`${url} and see ${url}.`)).toEqual([
      { inline: [link, " and see ", link, "."] },
    ]);
  });

  it("keeps balanced parentheses nested at any depth inside a bare URL", () => {
    const url = "https://example.com/a(b(c(d)e)f)";
    const link = { link: { href: url, content: url } };
    expect(markdownToStory(`${url} and see ${url}. Or (${url})!`)).toEqual([
      { inline: [link, " and see ", link, ". Or (", link, ")!"] },
    ]);
  });

  it("trims an unbalanced closing paren after a bare URL", () => {
    const link = { link: { href: "https://example.com/a", content: "https://example.com/a" } };
    expect(markdownToStory("(see https://example.com/a)")).toEqual([
      { inline: ["(see ", link, ")"] },
    ]);
  });

  it("keeps punctuation before a stray paren out of a bare URL", () => {
    const link = { link: { href: "https://example.com/a", content: "https://example.com/a" } };
    expect(markdownToStory("see https://example.com/a:( sad")).toEqual([
      { inline: ["see ", link, ":( sad"] },
    ]);
  });

  it("keeps an unmatched closing paren inside a bare URL", () => {
    const url = "https://example.com/?q=a)b";
    expect(markdownToStory(url)).toEqual([{ inline: [{ link: { href: url, content: url } }] }]);
  });

  const chart = {
    block: { image: { src: "https://example.com/chart.png", alt: "chart", height: 0, width: 0 } },
  };

  it.each([
    {
      markdown: "Here is the chart ![chart](https://example.com/chart.png)",
      expected: [{ inline: ["Here is the chart "] }, chart],
    },
    {
      markdown: "## Results ![chart](https://example.com/chart.png)",
      expected: [{ block: { header: { tag: "h2", content: ["Results "] } } }, chart],
    },
    {
      markdown: "## ![chart](https://example.com/chart.png)",
      expected: [chart],
    },
    {
      markdown: "> see ![chart](https://example.com/chart.png)",
      expected: [{ inline: [{ blockquote: ["see "] }] }, chart],
    },
    {
      markdown: "**look ![chart](https://example.com/chart.png)** now",
      expected: [{ inline: [{ bold: ["look "] }, " now"] }, chart],
    },
    {
      markdown: "- see **![chart](https://example.com/chart.png)**",
      expected: [{ inline: ["- see "] }, chart],
    },
  ])("hoists the image in $markdown to a native image block", ({ markdown, expected }) => {
    expect(markdownToStory(markdown)).toEqual(expected);
  });
});

describe("markdownToStory paragraph boundaries", () => {
  it.each(["####### heading", "# "])("preserves non-heading %j as ordinary text", (markdown) => {
    expect(markdownToStory(markdown)).toEqual([{ inline: [markdown] }]);
  });

  it("continues past a hashtag and still separates the next heading", () => {
    expect(markdownToStory("intro\n#tag\n## Heading\ntail")).toEqual([
      { inline: ["intro", { break: null }, "#tag"] },
      { block: { header: { tag: "h2", content: ["Heading"] } } },
      { inline: ["tail"] },
    ]);
  });
});

describe("markdownToStory list rendering", () => {
  it.each(listRenderingFixtures)("$name", ({ markdown, expected }) => {
    expect(markdownToStory(markdown)).toEqual(expected);
  });

  it("preserves a list with lazy continuation after preceding paragraph text", () => {
    expect(markdownToStory("intro\n- one\n- two\noutro")).toEqual([
      {
        inline: [
          "intro",
          { break: null },
          "- one",
          { break: null },
          "- two",
          { break: null },
          "outro",
        ],
      },
    ]);
  });

  it("keeps a blank-separated outer sibling attached after a nested list", () => {
    expect(markdownToStory("- parent\n  - child\n\n- sibling")).toEqual(
      listStory("unordered", [
        list("unordered", [{ item: ["child"] }], ["parent"]),
        { item: ["sibling"] },
      ]),
    );
  });

  it.each([
    {
      name: "non-1 ordered starts",
      markdown: "5. five\n6. six",
      expected: [{ inline: ["5. five", { break: null }, "6. six"] }],
    },
    {
      name: "consecutive nested list styles",
      markdown: "- parent\n  - bullet child\n  1. numbered child",
      expected: [
        {
          inline: [
            "- parent",
            { break: null },
            "  - bullet child",
            { break: null },
            "  1. numbered child",
          ],
        },
      ],
    },
    {
      name: "four-space-indented list-like text",
      markdown: "    - literal",
      expected: [{ inline: ["    - literal"] }],
    },
    {
      name: "under-indented children of wide ordered markers",
      markdown: "1. parent\n  - child",
      expected: [{ inline: ["1. parent", { break: null }, "  - child"] }],
    },
    {
      name: "block-level content inside list items",
      markdown: "- foo\n\n      bar",
      expected: [{ inline: ["- foo"] }, { inline: ["      bar"] }],
    },
    {
      name: "blank-separated item paragraphs",
      markdown: "- first\n\n  second",
      expected: [{ inline: ["- first"] }, { inline: ["  second"] }],
    },
    {
      name: "indented code beginning with a marker",
      markdown: "- foo\n\n      - literal",
      expected: [{ inline: ["- foo"] }, { inline: ["      - literal"] }],
    },
    {
      name: "parent content after a nested list",
      markdown: "- parent\n  - child\n\n  tail",
      expected: [{ inline: ["- parent", { break: null }, "  - child"] }, { inline: ["  tail"] }],
    },
    {
      name: "images inside list items",
      markdown: "- ![diagram](https://example.com/diagram.png)",
      expected: [
        { inline: ["- "] },
        {
          block: {
            image: { src: "https://example.com/diagram.png", alt: "diagram", height: 0, width: 0 },
          },
        },
      ],
    },
    {
      name: "indented continuation lines",
      markdown: "- first line\n  continued\n- second",
      expected: [
        {
          inline: ["- first line", { break: null }, "  continued", { break: null }, "- second"],
        },
      ],
    },
    {
      name: "tab-indented underflow beneath a padded marker",
      markdown: "-    parent\n \t- child",
      expected: [{ inline: ["-    parent", { break: null }, " \t- child"] }],
    },
    {
      name: "ordered markers longer than nine digits",
      markdown: "0000000001. value",
      expected: [{ inline: ["0000000001. value"] }],
    },
    {
      name: "same-line nested list syntax",
      markdown: "- - child",
      expected: [{ inline: ["- - child"] }],
    },
    {
      name: "blockquote marker without whitespace",
      markdown: "- >quoted",
      expected: [{ inline: ["- >quoted"] }],
    },
  ])("preserves $name as plain story content", ({ markdown, expected }) => {
    expect(markdownToStory(markdown)).toEqual(expected);
  });

  it("keeps different ordered delimiters as separate native lists", () => {
    expect(markdownToStory("1. first\n1) reset")).toEqual([
      ...listStory("ordered", [{ item: ["first"] }]),
      ...listStory("ordered", [{ item: ["reset"] }]),
    ]);
  });

  it("keeps ordered task items in an ordered native listing", () => {
    expect(markdownToStory("1. [ ] first\n2. [x] second")).toEqual(
      listStory("ordered", [
        { item: [{ task: { checked: false, content: ["first"] } }] },
        { item: [{ task: { checked: true, content: ["second"] } }] },
      ]),
    );
  });

  it("keeps variably indented ordered siblings in one native list", () => {
    expect(markdownToStory(" 1. first\n2. second")).toEqual(
      listStory("ordered", [{ item: ["first"] }, { item: ["second"] }]),
    );
  });

  it("preserves a non-interrupting ordered marker as lazy text", () => {
    expect(markdownToStory("- first\n2. continuation")).toEqual([
      { inline: ["- first", { break: null }, "2. continuation"] },
    ]);
  });

  it("keeps block-looking task text representable", () => {
    expect(markdownToStory("- [ ] - follow up")).toEqual(
      listStory("tasklist", [{ item: [{ task: { checked: false, content: ["- follow up"] } }] }]),
    );
  });

  it("keeps whitespace-only items in their native list", () => {
    expect(markdownToStory("- first\n-     \n- third")).toEqual(
      listStory("unordered", [{ item: ["first"] }, { item: [] }, { item: ["third"] }]),
    );
  });

  it("preserves an empty same-marker nested item as paragraph text", () => {
    expect(markdownToStory("- parent\n  -")).toEqual([
      { inline: ["- parent", { break: null }, "  -"] },
    ]);
  });

  it("accepts a tab as an unchecked task marker", () => {
    expect(markdownToStory("- [\t] todo")).toEqual(
      listStory("tasklist", [{ item: [{ task: { checked: false, content: ["todo"] } }] }]),
    );
  });

  it("preserves blank-separated siblings after an unsupported list item", () => {
    expect(markdownToStory("- # heading\n\n- sibling")).toEqual([
      { inline: ["- # heading"] },
      { inline: ["- sibling"] },
    ]);
  });

  it("keeps the unsupported outer marker across nested marker styles", () => {
    expect(markdownToStory("- # heading\n  * child\n\n- sibling")).toEqual([
      { inline: ["- # heading", { break: null }, "  * child"] },
      { inline: ["- sibling"] },
    ]);
  });

  it("does not let an empty list item interrupt a paragraph", () => {
    expect(markdownToStory("foo\n*")).toEqual([{ inline: ["foo", { break: null }, "*"] }]);
  });

  it.each(["- ~~~", "- ___", "-     code"])(
    "preserves block-level marker body %s as plain content",
    (markdown) => {
      expect(markdownToStory(markdown)).toEqual([{ inline: [markdown] }]);
    },
  );

  it.each([
    { markdown: "- - -", expected: [{ inline: ["- - -"] }] },
    { markdown: "* * *", expected: [{ inline: [{ italics: [" "] }, " *"] }] },
  ])("does not convert thematic break $markdown into a listing", ({ markdown, expected }) => {
    expect(markdownToStory(markdown)).toEqual(expected);
  });

  it("preserves lazy continuation text with its list markers", () => {
    expect(markdownToStory("- first\ncontinued\n- second")).toEqual([
      { inline: ["- first", { break: null }, "continued", { break: null }, "- second"] },
    ]);
  });
});
