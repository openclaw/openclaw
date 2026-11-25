import { expect, it } from "vitest";
import { markdownToStory, type Story } from "./story.js";
type Inline = Extract<Story[number], { inline: unknown }>["inline"];
type Listing = Extract<
  Extract<Story[number], { block: unknown }>["block"],
  { listing: unknown }
>["listing"];
type List = Extract<Listing, { list: unknown }>["list"];
const inline = (...content: Inline): Story => [{ inline: content }];
const link = (href: string, content = href) => ({ link: { href, content } });
const image = (src: string, alt: string): Story[number] => ({
  block: { image: { src, alt, height: 0, width: 0 } },
});
const list = (type: List["type"], items: Listing[], contents: Inline = []): Listing => ({
  list: { type, contents, items },
});
const listing = (type: List["type"], items: Listing[]): Story => [
  { block: { listing: list(type, items) } },
];
const plain = (...paragraphs: string[]): Story =>
  paragraphs.map((paragraph) => ({
    inline: paragraph
      .split("\n")
      .flatMap<Inline[number]>((line, index) => (index ? [{ break: null }, line] : [line])),
  }));
const nested = "https://example.com/a(b(c(d)e)f)";
const wiki = "https://en.wikipedia.org/wiki/Function_(mathematics)";
const chart = image("https://example.com/chart.png", "chart");

it.each<[string, Story]>([
  [
    "- [ ] todo\n- [x] **done**",
    listing("tasklist", [
      { item: [{ task: { checked: false, content: ["todo"] } }] },
      { item: [{ task: { checked: true, content: [{ bold: ["done"] }] } }] },
    ]),
  ],
  [
    "- parent\n  1. first\n  2. second\n- sibling",
    listing("unordered", [
      list("ordered", [{ item: ["first"] }, { item: ["second"] }], ["parent"]),
      { item: ["sibling"] },
    ]),
  ],
  [
    "**bold** __bold__ *italic* _italic_ ~~strike~~ `code`",
    inline(
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
    ),
  ],
  [
    "~zod [site](https://example.com)",
    inline({ ship: "~zod" }, " ", link("https://example.com", "site")),
  ],
  [`See [math](${wiki})!`, inline("See ", link(wiki, "math"), "!")],
  [`![diagram](${nested}.png)`, [image(`${nested}.png`, "diagram")]],
  [
    `${nested} and see ${nested}. Or (${nested})!`,
    inline(link(nested), " and see ", link(nested), ". Or (", link(nested), ")!"),
  ],
  ["see https://example.com/a:( sad", inline("see ", link("https://example.com/a"), ":( sad")],
  ["> see ![chart](https://example.com/chart.png)", [...inline({ blockquote: ["see "] }), chart]],
  ["- see **![chart](https://example.com/chart.png)**", [...inline("- see "), chart]],
  [
    "intro\n#tag\n## Heading\ntail",
    [
      ...inline("intro", { break: null }, "#tag"),
      { block: { header: { tag: "h2", content: ["Heading"] } } },
      ...inline("tail"),
    ],
  ],
])("renders Markdown without losing structure: %s", (markdown, expected) => {
  expect(markdownToStory(markdown)).toEqual(expected);
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
