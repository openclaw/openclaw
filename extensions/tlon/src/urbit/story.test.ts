import { expect, it } from "vitest";
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
function plain(...paragraphs: string[]): Story {
  return paragraphs.map((paragraph) => ({
    inline: paragraph
      .split("\n")
      .flatMap<string | { break: null }>((line, index) =>
        index ? [{ break: null }, line] : [line],
      ),
  }));
}
it.each([
  [
    "- [ ] todo\n- [x] **done**",
    listStory("tasklist", [
      { item: [{ task: { checked: false, content: ["todo"] } }] },
      { item: [{ task: { checked: true, content: [{ bold: ["done"] }] } }] },
    ]),
  ],
  [
    "- parent\n  1. first\n  2. second\n- sibling",
    listStory("unordered", [
      list("ordered", [{ item: ["first"] }, { item: ["second"] }], ["parent"]),
      { item: ["sibling"] },
    ]),
  ],
] as const)("renders native listing: %s", (markdown, expected) => {
  expect(markdownToStory(markdown)).toEqual(expected);
});
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
it("hoists an image with its complete destination", () => {
  const url = "https://example.com/a(b(c(d)e)f).png";
  expect(markdownToStory(`![diagram](${url})`)).toEqual([
    { block: { image: { src: url, alt: "diagram", height: 0, width: 0 } } },
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
it("continues past a hashtag and still separates the next heading", () => {
  expect(markdownToStory("intro\n#tag\n## Heading\ntail")).toEqual([
    { inline: ["intro", { break: null }, "#tag"] },
    { block: { header: { tag: "h2", content: ["Heading"] } } },
    { inline: ["tail"] },
  ]);
});
it.each([
  ["intro\n- one\n- two\noutro"],
  ["5. five\n6. six"],
  ["- parent\n  - bullet child\n  1. numbered child"],
  ["- foo", "      bar"],
  ["- foo", "      - literal"],
  ["- parent\n  - child", "  tail"],
  ["-    parent\n \t- child"],
  ["- first\n2. continuation"],
  ["- parent\n  -"],
])("preserves unsupported listing as paragraphs: %j", (...paragraphs) => {
  expect(markdownToStory(paragraphs.join("\n\n"))).toEqual(plain(...paragraphs));
});
