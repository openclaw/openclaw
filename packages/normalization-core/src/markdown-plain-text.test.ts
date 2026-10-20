import { describe, expect, it } from "vitest";
import { flattenMarkdownToPlainText } from "./markdown-plain-text.js";

describe("flattenMarkdownToPlainText", () => {
  it.each([
    ["fenced code blocks", "Before\n```ts\nconst hidden = true;\n```\nAfter", "Before After"],
    ["tilde fences", "Before\n~~~ts\nconst hidden = true;\n~~~\nAfter", "Before After"],
    ["long tilde fences", "Before\n~~~~md\n~~~ts\nhidden\n~~~\n~~~~\nAfter", "Before After"],
    ["longer closing fences", "Before\n~~~\nhidden\n~~~~\nAfter", "Before After"],
    ["mismatched markers", "Before\n~~~\nhidden\n```\nstill hidden\n~~~\nAfter", "Before After"],
    [
      "closing marker with text",
      "Before\n~~~\nhidden\n~~~not a closer\nstill hidden\n~~~\nAfter",
      "Before After",
    ],
    ["indented fences and CRLF", "Before\r\n   ~~~ts\r\nhidden\r\n  ~~~\r\nAfter", "Before After"],
    ["quoted backtick fences", "Before\n> ```ts\n> hidden\n> ```\nAfter", "Before After"],
    ["list backtick fences", "Before\n- ```ts\n  hidden\n  ```\nAfter", "Before After"],
    [
      "list continuation fences",
      "Before\n- item\n  ```ts\n    hidden\n    ```\nAfter",
      "Before item After",
    ],
    ["inline tilde runs", "Before ~~~ after", "Before ~~~ after"],
    [
      "tilde markers inside backtick blocks",
      "Before\n```md\n~~~\n```\nAfter\n~~~ts\nhidden\n~~~\nTail",
      "Before After Tail",
    ],
    [
      "tilde markers inside long backtick blocks",
      "Before\n````md\n~~~\n````\nAfter\n~~~ts\nhidden\n~~~\nTail",
      "Before ` After Tail",
    ],
    [
      "tilde list continuation",
      "Before\n- item\n  ~~~ts\n    hidden\n    ~~~\nAfter",
      "Before item After",
    ],
    ["unfinished tilde fences", "Before\n~~~ts\nhidden", "Before ~~~ts hidden"],
    [
      "unfinished quote container",
      "Before\n> ~~~ts\n> hidden\nAfter\n> ~~~\nTail",
      "Before ~ts hidden After ~ Tail",
    ],
    [
      "unfinished list container",
      "Before\n- ~~~ts\n  hidden\nAfter\n~~~\nTail",
      "Before ~ts hidden After ~ Tail",
    ],
    [
      "indented non-closing marker",
      "Before\n~~~ts\nhidden\n    ~~~\nAfter",
      "Before ~ts hidden ~ After",
    ],
    ["list tilde fences", "Before\n- ~~~ts\n  hidden\n  ~~~\nAfter", "Before After"],
    ["quoted list tilde fences", "Before\n- > ~~~ts\n  > hidden\n  > ~~~\nAfter", "Before After"],
    [
      "literal Unicode separator",
      "Before\u2028~~~ts\nhidden\n~~~\nAfter",
      "Before ~ts hidden ~ After",
    ],
    [
      "tilde markers inside quoted backtick blocks",
      "Before\n> ```md\n> ~~~\n> ```\nAfter\n~~~ts\nhidden\n~~~\nTail",
      "Before After Tail",
    ],
    [
      "tilde after a backtick list continuation",
      "Before\n- item\n  ```md\n    ~~~\n    ```\nAfter\n~~~ts\nhidden\n~~~\nTail",
      "Before item After Tail",
    ],
    ["inline code", "Use `pnpm test` now", "Use pnpm test now"],
    ["empty completed tilde fence", "Before\n~~~\n~~~\nAfter", "Before After"],
    ["unfinished empty tilde fence", "Before\n~~~\n", "Before ~~~"],
    [
      "lazy list continuation",
      "10. item\ncontinued\n    ~~~\n    secret\n    ~~~",
      "item continued",
    ],
    [
      "quoted lazy list continuation",
      "> - item\ncontinued\n>     ~~~\n>     hidden\n>     ~~~",
      "- item continued",
    ],
    ["overindented backtick closer", " ```md\n    ```\n~~~\n```\nVisible\n~~~ ", "~ Visible ~"],
    [
      "indented paragraph heading",
      "Intro\n    # heading\n<span>\n~~~\nsecret\n~~~",
      "Intro # heading <span>",
    ],
    [
      "indented paragraph quote",
      "Intro\n    > still paragraph\n<span>\n~~~\nsecret\n~~~",
      "Intro > still paragraph <span>",
    ],
    ["non-ASCII space in HTML", "<div>\n\u00a0\n~~~\nsecret\n~~~", "<div> ~ secret ~"],
    ["blank quote ends HTML block", "> <div>\n>\n> ~~~\n> secret\n> ~~~", "<div>"],
    ["blank quote within list fence", "> - ~~~\n>   hidden\n>\n>   ~~~\nAfter", "After"],
    [
      "blank quote within raw HTML",
      "> <pre>\n>\n> ~~~\n> Important\n> ~~~\n> </pre>",
      "<pre> ~ Important ~ </pre>",
    ],
    ["bare empty list marker", "-\n    ~~~\n    secret\n    ~~~", ""],
    ["bare empty ordered marker", "1.\n    ~~~\n    secret\n    ~~~", ""],
    [
      "empty list cannot interrupt paragraph",
      "Intro\n- \n    ~~~\n    visible\n    ~~~",
      "Intro ~ visible ~",
    ],
    ["standalone setext marker", "====\n<span>\n~~~\nsecret\n~~~", "==== <span>"],
    ["empty ATX heading", "#\n<span>\n~~~\nImportant\n~~~", "<span> ~ Important ~"],
    ["empty quote marker", ">\n> <span>\n> ~~~\n> Important\n> ~~~", "<span> ~ Important ~"],
    ["empty list marker", "- \n  <span>\n  ~~~\n  Important\n  ~~~", "<span> ~ Important ~"],
    [
      "link definition cannot interrupt paragraph",
      "Intro\n[id]: /url\n<span>\n~~~\nsecret\n~~~",
      "Intro [id]: /url <span>",
    ],
    [
      "thematic break before indented code",
      "- - -\n    ~~~\n    Important\n    ~~~",
      "- - ~ Important ~",
    ],
    [
      "literal list marker in HTML",
      "<div>\n- literal\n\n    ~~~\n    Important\n    ~~~",
      "<div> literal ~ Important ~",
    ],
    ["list after indented code", "    code\n2. ~~~\n   secret\n   ~~~", "code"],
    ["different raw HTML closing tag", "<script>\n</style>\n~~~\nsecret\n~~~", "<script> </style>"],
    ["self-closing raw HTML tag", "<script/>\n~~~\nsecret\n~~~", "<script/> ~ secret ~"],
    [
      "HTML block after link definition",
      "[id]: /url\n<span>\n~~~\nImportant\n~~~",
      "[id]: /url <span> ~ Important ~",
    ],
    ["numbered paragraph continuation", "Intro\n2. ~~~\n  important\n  ~~~", "Intro ~ important ~"],
    ["quoted tab indentation", "> \t~~~ts\n> \thidden\n> \t~~~\nAfter", "After"],
    ["paragraph-continuing HTML", "Intro\n<span>\n~~~\nsecret\n~~~\nEnd", "Intro <span> End"],
    ["invalid backtick opener", "Intro\n```bad`info\n~~~\nsecret\n~~~\nEnd", "Intro bad`info End"],
    ["carriage-return fences", "Before\r~~~ts\rhidden\r~~~\rAfter", "Before After"],
    ["indented list code", "-     ~~~\n      visible\n      ~~~", "~ visible ~"],
    ["HTML block content", "<div>\n~~~\nImportant\n~~~\n</div>", "<div> ~ Important ~ </div>"],
    [
      "fences after HTML blocks",
      "<div>\n~~~\nImportant\n~~~\n</div>\n\n~~~ts\nhidden\n~~~\nAfter",
      "<div> ~ Important ~ </div> After",
    ],
    ["HTML comments", "<!--\n~~~\nImportant\n~~~\n-->\nAfter", "<!-- ~ Important ~ --> After"],
    [
      "raw HTML tags",
      "<pre>\n~~~\nImportant\n~~~\n</pre>\nAfter",
      "<pre> ~ Important ~ </pre> After",
    ],
    [
      "links",
      "Read the [deployment guide](https://example.com/deploy)",
      "Read the deployment guide",
    ],
    ["images", "Status ![green check](https://example.com/check.png)", "Status green check"],
    [
      "nested link label brackets",
      "Read the [Report [Q3 [draft]]](https://example.com/r) and then deploy.",
      "Read the Report [Q3 [draft]] and then deploy.",
    ],
    [
      "balanced destination parentheses",
      "Read the [report](https://example.com/report_(Q3_(final))) and then deploy.",
      "Read the report and then deploy.",
    ],
    [
      "escaped destination parentheses",
      "Read the [report](https://example.com/report\\)Q3) and then deploy.",
      "Read the report and then deploy.",
    ],
    [
      "images with balanced destination parentheses",
      "Status ![check](https://example.com/check_(1).png) done",
      "Status check done",
    ],
    ["empty link labels", "Keep [](https://example.com) here", "Keep [](https://example.com) here"],
    ["link titles", 'See [docs](https://example.com "Docs (v2)") now', "See docs now"],
    [
      "quoted link titles with unbalanced parentheses",
      "See [docs](https://example.com \"Docs (v2\") and [guide](https://example.com 'Guide v2)') now",
      "See docs and guide now",
    ],
    ["parenthesized link titles", "See [docs](https://example.com (Docs v2)) now", "See docs now"],
    [
      "angle-bracket link destinations",
      "See [docs](<https://example.com/a b(>) now",
      "See docs now",
    ],
    [
      "linked images whose destination holds a bracket",
      "Badge [![build](https://example.com/badge[.svg)](https://ci.example.com) ok",
      "Badge build ok",
    ],
    [
      "linked images whose title holds a bracket",
      'Badge [![build](https://example.com/badge.svg "Build [main")](https://ci.example.com) ok',
      "Badge build ok",
    ],
    [
      "non-breaking spaces inside bare link destinations",
      "Read [docs](https://example.com/a b) now",
      "Read docs now",
    ],
    [
      "non-breaking spaces inside link destinations with parentheses",
      "Read [docs](https://example.com/a(b c)) now",
      "Read docs now",
    ],
    [
      "unclosed link destinations",
      "Keep [this](https://example.com/open( text",
      "Keep [this](https://example.com/open( text",
    ],
    [
      "heading and list markers",
      "# Heading\n- bullet\n+ plus\n* star\n2) numbered\n> quote",
      "Heading bullet plus star numbered quote",
    ],
    ["emphasis", "**bold** _italic_ ~~struck~~", "bold italic struck"],
    [
      "literal underscores and tildes",
      "Use foo_bar_baz from ~/.openclaw",
      "Use foo_bar_baz from ~/.openclaw",
    ],
    ["multiline whitespace", "First\n\n  second\t third", "First second third"],
  ])("flattens %s", (_label, input, expected) => {
    expect(flattenMarkdownToPlainText(input)).toBe(expected);
  });

  it("flattens deeply nested links without exhausting the stack", () => {
    const depth = 20_000;
    const input = `${"[".repeat(depth)}deep${"](https://example.com)".repeat(depth)} end`;
    expect(flattenMarkdownToPlainText(input)).toBe("deep end");
  });
});
