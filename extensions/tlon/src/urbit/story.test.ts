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
  ])("renders %j without losing literal text or nested styles", ({ markdown, inline }) => {
    expect(markdownToStory(markdown)).toEqual([{ inline }]);
  });

  it.each(["https://example.com/a(b(c(d)e)f).png"])(
    "hoists an image with its complete destination %s",
    (url) => {
      expect(markdownToStory(`![diagram](${url})`)).toEqual([
        {
          block: {
            image: { src: url, alt: "diagram", height: 0, width: 0 },
          },
        },
      ]);
    },
  );

  it("keeps sentence punctuation after a bare URL out of the link", () => {
    const link = { link: { href: "https://example.com/a", content: "https://example.com/a" } };
    expect(markdownToStory("see https://example.com/a. Or (https://example.com/a)!")).toEqual([
      { inline: ["see ", link, ". Or (", link, ")!"] },
    ]);
  });

  it("keeps balanced parentheses nested at any depth inside a bare URL", () => {
    const url = "https://example.com/a(b(c(d)e)f)";
    const link = { link: { href: url, content: url } };
    expect(markdownToStory(`${url} and see ${url}. Or (${url})!`)).toEqual([
      { inline: [link, " and see ", link, ". Or (", link, ")!"] },
    ]);
  });

  it("keeps punctuation before a stray paren out of a bare URL", () => {
    const link = { link: { href: "https://example.com/a", content: "https://example.com/a" } };
    expect(markdownToStory("see https://example.com/a:( sad")).toEqual([
      { inline: ["see ", link, ":( sad"] },
    ]);
  });

  const chart = {
    block: { image: { src: "https://example.com/chart.png", alt: "chart", height: 0, width: 0 } },
  };

  it.each([
    {
      markdown: "> see ![chart](https://example.com/chart.png)",
      expected: [{ inline: [{ blockquote: ["see "] }] }, chart],
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
      name: "block-level content inside list items",
      markdown: "- foo\n\n      bar",
      expected: [{ inline: ["- foo"] }, { inline: ["      bar"] }],
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
      name: "tab-indented underflow beneath a padded marker",
      markdown: "-    parent\n \t- child",
      expected: [{ inline: ["-    parent", { break: null }, " \t- child"] }],
    },
  ])("preserves $name as plain story content", ({ markdown, expected }) => {
    expect(markdownToStory(markdown)).toEqual(expected);
  });

  it("preserves a non-interrupting ordered marker as lazy text", () => {
    expect(markdownToStory("- first\n2. continuation")).toEqual([
      { inline: ["- first", { break: null }, "2. continuation"] },
    ]);
  });

  it("preserves an empty same-marker nested item as paragraph text", () => {
    expect(markdownToStory("- parent\n  -")).toEqual([
      { inline: ["- parent", { break: null }, "  -"] },
    ]);
  });

  it("keeps the unsupported outer marker across nested marker styles", () => {
    expect(markdownToStory("- # heading\n  * child\n\n- sibling")).toEqual([
      { inline: ["- # heading", { break: null }, "  * child"] },
      { inline: ["- sibling"] },
    ]);
  });
});
