import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { describe, expect, it } from "vitest";
import {
  buildFeishuPresentationCard,
  renderFeishuReplyPayload,
  feishuCardWithinTableLimit,
  hasUndrawableCardTable,
  isFeishuCardWithinEnvelope,
  shouldUseCard,
  withinCardTableLimit,
} from "./presentation-card.js";

describe("buildFeishuPresentationCard", () => {
  it("renders table blocks through the portable text fallback", () => {
    const presentation = normalizeMessagePresentation({
      blocks: [
        {
          type: "table",
          caption: "Pipeline",
          headers: ["Account", "Stage", "ARR"],
          rows: [
            ["Acme", "Won", 125000],
            ["Globex", "Review", 82000],
          ],
        },
      ],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }

    expect(buildFeishuPresentationCard({ presentation }).body.elements).toEqual([
      {
        tag: "markdown",
        content:
          "Pipeline (table)\n- Account: Acme; Stage: Won; ARR: 125000\n- Account: Globex; Stage: Review; ARR: 82000",
      },
    ]);
  });

  // A context block is grey, and grey comes from an inline tag. A fence has to
  // open and close its own line, so the two cannot share one element.
  it.each([
    { tables: "code" as const, grey: false },
    { tables: "bullets" as const, grey: true },
  ])("renders a $tables context table the card can draw", ({ tables, grey }) => {
    const tableMarkdown = "| Name | Role |\n| --- | --- |\n| Ada | Lead |";
    const presentation = normalizeMessagePresentation({
      blocks: [{ type: "context", text: tableMarkdown }],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }
    const converted = convertMarkdownTables(tableMarkdown, tables);
    // Guard the fixture: the case only means anything while `code` still opens a fence.
    expect(converted.startsWith("```")).toBe(!grey);

    expect(
      buildFeishuPresentationCard({
        presentation,
        renderText: (text) => convertMarkdownTables(text, tables),
      }).body.elements,
    ).toEqual([
      {
        tag: "markdown",
        content: grey ? `<font color='grey'>${converted}</font>` : converted,
      },
    ]);
  });

  // The shared adapter cuts a block to the 4,000-character text limit before this
  // module runs, and `code` pads every cell and adds a fence afterwards, so a block
  // that arrived inside the limit can leave it. Each piece is its own element and
  // carries its own marker pair.
  it("splits a projected table that outgrows the card text limit", () => {
    const header = "Quarterly revenue attainment by named account owner";
    const tableMarkdown = [
      `| ${header} | n |`,
      "| --- | --- |",
      ...Array.from({ length: 80 }, (_entry, index) => `| r${index} | ${index % 10} |`),
    ].join("\n");
    const presentation = normalizeMessagePresentation({
      blocks: [{ type: "text", text: tableMarkdown }],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }
    // Guard the fixture: the case only means anything while the authored block fits the
    // limit and the projection pushes it past.
    expect(tableMarkdown.length).toBeLessThanOrEqual(4000);
    expect(convertMarkdownTables(tableMarkdown, "code").length).toBeGreaterThan(4000);

    const elements = buildFeishuPresentationCard({
      presentation,
      renderText: (text) => convertMarkdownTables(text, "code"),
    }).body.elements as { tag: string; content: string }[];

    expect(elements.length).toBeGreaterThan(1);
    for (const element of elements) {
      expect(element.tag).toBe("markdown");
      expect(element.content.length).toBeLessThanOrEqual(4000);
      // Each element closes what it opened.
      const markers = element.content.match(/^```/gmu) ?? [];
      expect(markers.length).toBe(2);
    }
    const joined = elements.map((element) => element.content).join("");
    expect(joined).toContain(header);
    expect(joined).toContain("r0");
    expect(joined).toContain("r79");
  });

  // A card does not draw a table inside a quote, so those rows leave the message rather than
  // degrade. A presentation cannot take the post path without losing its controls, so its
  // elements take the same list the streamed preview takes.
  it("lists a quoted table a card cannot draw and keeps the controls", () => {
    const quoted = "> | Name | Role |\n> | --- | --- |\n> | Ada | Lead |";
    const presentation = normalizeMessagePresentation({
      blocks: [
        { type: "text", text: quoted },
        {
          type: "buttons",
          buttons: [{ label: "Allow", action: { type: "command", command: "/ok" } }],
        },
      ],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }

    const elements = buildFeishuPresentationCard({
      presentation,
      // block mode leaves a table for the card to draw, which is the case this is about.
      renderText: (text) => text,
      tableMode: "block",
    }).body.elements as { tag: string; content?: string }[];

    const markdown = elements.find((element) => element.tag === "markdown")?.content ?? "";
    expect(markdown).toContain("Ada");
    expect(markdown).not.toContain("| --- |");
    expect(elements.some((element) => element.tag === "button")).toBe(true);
  });

  // The list above is a card-safe shape, and off asks for the authored pipes rather than for
  // a shape. Its renderer converts nothing, so without the mode the card element would read
  // the raw rows as undrawable and list them anyway.
  it("keeps an authored quoted table on an off card", () => {
    const quoted = "> | Name | Role |\n> | --- | --- |\n> | Ada | Lead |";
    const presentation = normalizeMessagePresentation({ blocks: [{ type: "text", text: quoted }] });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }

    const elements = buildFeishuPresentationCard({
      presentation,
      renderText: (text) => text,
      tableMode: "off",
    }).body.elements as { tag: string; content?: string }[];

    const markdown = elements.find((element) => element.tag === "markdown")?.content ?? "";
    expect(markdown).toContain("| --- |");
    expect(markdown).not.toContain("•");
  });

  // A table block carries as many rows as the producer had, and its linear form is one
  // element unless it is cut.
  it("splits a table block whose linear form outgrows the card text limit", () => {
    const presentation = normalizeMessagePresentation({
      blocks: [
        {
          type: "table",
          caption: "Roster",
          headers: ["name", "detail"],
          rows: Array.from({ length: 120 }, (_entry, index) => [
            `row${index}`,
            `detail ${index} ${"d".repeat(20)}`,
          ]),
        },
      ],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }

    const elements = buildFeishuPresentationCard({
      presentation,
      renderText: (text) => convertMarkdownTables(text, "code"),
    }).body.elements as { tag: string; content: string }[];

    expect(elements.length).toBeGreaterThan(1);
    for (const element of elements) {
      expect(element.content.length).toBeLessThanOrEqual(4000);
    }
    const joined = elements.map((element) => element.content).join("");
    expect(joined).toContain("row0");
    expect(joined).toContain("row119");
  });

  // A quote prefix hides a fence marker from the chunker's scanner, so the cut it makes
  // leaves an opener in one element and a closer in another. Neither draws a block, and
  // no limit repairs it, so the projection gives way to the text as authored.
  it("keeps a quoted table readable when its projection cannot survive the split", () => {
    const tableMarkdown = [
      "> | name | detail |",
      "> | --- | --- |",
      ...Array.from({ length: 40 }, (_entry, index) => `> | row${index} | d |`),
      `> | wide | ${"w".repeat(220)} |`,
    ].join("\n");
    const presentation = normalizeMessagePresentation({
      blocks: [{ type: "text", text: tableMarkdown }],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }
    const converted = convertMarkdownTables(tableMarkdown, "code");
    // Guard the fixture: the case only means anything while the authored block fits the
    // limit, the projection pushes it past, and its markers carry the quote prefix.
    expect(tableMarkdown.length).toBeLessThanOrEqual(4000);
    expect(converted.length).toBeGreaterThan(4000);
    expect(converted).toContain("> ```");

    const elements = buildFeishuPresentationCard({
      presentation,
      renderText: (text) => convertMarkdownTables(text, "code"),
    }).body.elements as { tag: string; content: string }[];

    for (const element of elements) {
      expect(element.content.length).toBeLessThanOrEqual(4000);
      // An element opens and closes its own fences or carries none at all.
      expect((element.content.match(/^(?:&gt; ?)*```/gmu) ?? []).length % 2).toBe(0);
    }
    const joined = elements.map((element) => element.content).join("");
    for (let index = 0; index < 40; index += 1) {
      expect(joined).toContain(`row${index}`);
    }
    expect(joined).toContain("wide");
  });

  // The conversion hides a quoted table inside a quoted fence, so the card-safe renderer
  // finds no table left to list and the split hands the authored rows back. A card draws
  // nothing at all for a table under a quote, so those rows leave the message entirely,
  // where the projection had only made them unreadable. The shape a cut gives way to has
  // to be one the card still draws.
  it("lists a quoted table whose projection cannot survive the split", () => {
    const tableMarkdown = [
      "> | name | detail |",
      "> | --- | --- |",
      ...Array.from({ length: 40 }, (_entry, index) => `> | row${index} | d |`),
      `> | wide | ${"w".repeat(220)} |`,
    ].join("\n");
    const presentation = normalizeMessagePresentation({
      blocks: [{ type: "text", text: tableMarkdown }],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }
    const converted = convertMarkdownTables(tableMarkdown, "code");
    // Guard the fixture: the authored rows are a table no card draws, the projection hides
    // that table inside a fence so nothing is left for the element renderer to list, and the
    // projection is long enough that the cut it cannot carry is the one that decides.
    expect(hasUndrawableCardTable(tableMarkdown)).toBe(true);
    expect(hasUndrawableCardTable(converted)).toBe(false);
    expect(converted.length).toBeGreaterThan(4000);

    const contents = (
      buildFeishuPresentationCard({
        presentation,
        renderText: (text) => convertMarkdownTables(text, "code"),
        tableMode: "code",
      }).body.elements as { tag: string; content: string }[]
    )
      .filter((element) => element.tag === "markdown")
      .map((element) =>
        element.content.replace(/&gt;/gu, ">").replace(/&lt;/gu, "<").replace(/&amp;/gu, "&"),
      );

    for (const content of contents) {
      expect(hasUndrawableCardTable(content)).toBe(false);
    }
    const joined = contents.join("\n");
    expect(joined).toContain("\u2022");
    for (let index = 0; index < 40; index += 1) {
      expect(joined).toContain(`row${index}`);
    }
    expect(joined).toContain("wide");
  });

  // The colour tag is added after the split, so its own characters have to come out of
  // the budget the parts are sized to.
  it("keeps a projected context part inside the limit once the colour tag is added", () => {
    const tableMarkdown = [
      "| Region | Owner |",
      "| --- | --- |",
      ...Array.from({ length: 240 }, (_entry, i) => `| region-${i} | owner-name-${i} |`),
    ].join("\n");
    const presentation = normalizeMessagePresentation({
      blocks: [{ type: "context", text: tableMarkdown }],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }
    // Guard the fixture: bullets leaves no fence, so every part keeps the colour tag.
    const projected = convertMarkdownTables(tableMarkdown, "bullets");
    expect(projected).not.toContain("```");
    expect(projected.length).toBeGreaterThan(4000);

    const elements = buildFeishuPresentationCard({
      presentation,
      renderText: (text) => convertMarkdownTables(text, "bullets"),
    }).body.elements as { tag: string; content: string }[];

    expect(elements.length).toBeGreaterThan(1);
    for (const element of elements) {
      expect(element.content).toContain("<font color='grey'>");
      // This is the content the card sends, tag included.
      expect(element.content.length).toBeLessThanOrEqual(4000);
    }
  });

  // The shared adapter cuts an oversized block to the text limit before this plugin
  // renders anything, and that cut lands on the authored table, so every fragment after
  // the first starts on a data row and stops being a table. A builder test cannot see
  // that, because the split happens before the builder is called.
  it("projects a long presentation table before the adapter splits it", async () => {
    const tableMarkdown = [
      "| Name | Role |",
      "| --- | --- |",
      ...Array.from(
        { length: 260 },
        (_entry, i) => `| person-number-${i} | Regional Operations Lead |`,
      ),
    ].join("\n");
    // Guard the fixture: the authored block is several times the per-element limit.
    expect(tableMarkdown.length).toBeGreaterThan(4000);

    const { card } = await renderFeishuReplyPayload(
      { text: "", presentation: { blocks: [{ type: "text", text: tableMarkdown }] } } as never,
      {
        to: "chat_1",
        renderText: (text: string) => convertMarkdownTables(text, "code"),
      } as never,
    );

    const elements = (card?.body?.elements ?? []) as { tag: string; content?: string }[];
    const markdown = elements.filter((element) => element.tag === "markdown");
    expect(markdown.length).toBeGreaterThan(1);
    // Every element carries its own marker pair, so no fragment arrives as raw pipes.
    for (const element of markdown) {
      expect((element.content?.match(/^```/gmu) ?? []).length).toBe(2);
      expect(element.content?.length ?? 0).toBeLessThanOrEqual(4000);
    }
    const joined = markdown.map((element) => element.content).join("");
    expect(joined).toContain("Name");
    expect(joined).toContain("person-number-259");
  });

  // The element carries the escaped text, and escaping turns one ampersand into five
  // characters after the cut has been made, so a part sized to the limit can leave it.
  it("sizes a projected table by the length the element will carry", () => {
    const ampersands = "&".repeat(60);
    const tableMarkdown = [
      "| A | B |",
      "| --- | --- |",
      ...Array.from({ length: 120 }, () => `| ${ampersands} | x |`),
    ].join("\n");
    const presentation = normalizeMessagePresentation({
      blocks: [{ type: "text", text: tableMarkdown }],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }
    // Guard the fixture: the projection fits the limit only until it is escaped.
    const projected = convertMarkdownTables(tableMarkdown, "code");
    expect(projected.length).toBeGreaterThan(4000);

    const elements = buildFeishuPresentationCard({
      presentation,
      renderText: (text) => convertMarkdownTables(text, "code"),
    }).body.elements as { tag: string; content: string }[];

    for (const element of elements) {
      // The content here is already escaped, which is what the card sends.
      expect(element.content.length).toBeLessThanOrEqual(4000);
      expect((element.content.match(/^```/gmu) ?? []).length).toBe(2);
    }
    expect(elements.map((element) => element.content).join("")).toContain("&amp;");
  });

  // The fallback text is projected like any block and outgrows the limit the same way,
  // and it reaches the card ahead of the blocks rather than through them.
  it("splits a projected fallback that outgrows the card text limit", () => {
    const header = "Quarterly revenue attainment by named account owner";
    const tableMarkdown = [
      `| ${header} | n |`,
      "| --- | --- |",
      ...Array.from({ length: 80 }, (_entry, index) => `| r${index} | ${index % 10} |`),
    ].join("\n");
    const presentation = normalizeMessagePresentation({
      blocks: [{ type: "divider" }],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }
    expect(tableMarkdown.length).toBeLessThanOrEqual(4000);
    expect(convertMarkdownTables(tableMarkdown, "code").length).toBeGreaterThan(4000);

    const elements = buildFeishuPresentationCard({
      presentation,
      fallbackText: tableMarkdown,
      renderText: (text) => convertMarkdownTables(text, "code"),
    }).body.elements as { tag: string; content?: string }[];

    const markdownElements = elements.filter((element) => element.tag === "markdown");
    expect(markdownElements.length).toBeGreaterThan(1);
    for (const element of markdownElements) {
      expect(element.content?.length ?? 0).toBeLessThanOrEqual(4000);
      const markers = element.content?.match(/^```/gmu) ?? [];
      expect(markers.length).toBe(2);
    }
    const joined = markdownElements.map((element) => element.content).join("");
    expect(joined).toContain(header);
    expect(joined).toContain("r79");
  });
});

describe("isFeishuCardWithinEnvelope", () => {
  it("counts nested elements against the 200-element API limit", () => {
    const buildCard = (elementCount: number) => ({
      schema: "2.0",
      body: {
        elements: Array.from({ length: elementCount }, (_entry, index) => ({
          tag: "markdown",
          content: String(index),
        })),
      },
    });

    expect(isFeishuCardWithinEnvelope(buildCard(200))).toBe(true);
    expect(isFeishuCardWithinEnvelope(buildCard(201))).toBe(false);
  });
});

describe("withinCardTableLimit (parser-backed table counting)", () => {
  const pipedTable = "| a | b |\n| - | - |\n| 1 | 2 |";
  const pipelessTable = "a | b\n--- | ---\n1 | 2";
  const repeat = (table: string, count: number) =>
    Array.from({ length: count }, () => table).join("\n\n");

  it("accepts piped and pipe-less GFM tables at the 5-table boundary", () => {
    expect(withinCardTableLimit(repeat(pipedTable, 5))).toBe(true);
    expect(withinCardTableLimit(repeat(pipedTable, 6))).toBe(false);
    expect(withinCardTableLimit(repeat(pipelessTable, 5))).toBe(true);
    expect(withinCardTableLimit(repeat(pipelessTable, 6))).toBe(false);
  });

  it("counts alignment-colon delimiters toward the limit", () => {
    const alignPiped = "| a | b |\n|:--|--:|\n| 1 | 2 |";
    const alignPipeless = "c | d\n:---: | ---\n3 | 4";
    expect(withinCardTableLimit(repeat(alignPiped, 6))).toBe(false);
    expect(withinCardTableLimit(repeat(alignPipeless, 6))).toBe(false);
    expect(withinCardTableLimit(repeat(alignPiped, 5))).toBe(true);
  });

  it("does not count tables inside fenced code blocks", () => {
    expect(withinCardTableLimit("```\n" + repeat(pipedTable, 6) + "\n```")).toBe(true);
    expect(
      withinCardTableLimit("```\n" + repeat(pipedTable, 2) + "\n```\n\n" + repeat(pipedTable, 6)),
    ).toBe(false);
  });

  it("does not count thematic breaks or plain pipes in prose", () => {
    expect(withinCardTableLimit("---\n\nhello | world\n\n2024 | 2025")).toBe(true);
  });

  it("does not treat tables inside an HTML font wrapper as card table components", () => {
    expect(withinCardTableLimit(`<font color='grey'>${repeat(pipedTable, 6)}</font>`)).toBe(true);
  });
});

describe("feishuCardWithinTableLimit", () => {
  const table = "| a | b |\n| - | - |\n| 1 | 2 |";

  it("sums tables across all markdown elements of the card", () => {
    const card = {
      schema: "2.0",
      body: {
        elements: [
          { tag: "markdown", content: `${table}\n\n${table}\n\n${table}` },
          { tag: "hr" },
          { tag: "markdown", content: `${table}\n\n${table}\n\n${table}` },
        ],
      },
    };
    expect(feishuCardWithinTableLimit(card)).toBe(false);
  });

  it("accepts cards with at most 5 tables across elements", () => {
    const card = {
      schema: "2.0",
      body: {
        elements: [
          { tag: "markdown", content: `${table}\n\n${table}\n\n${table}` },
          { tag: "markdown", content: `${table}\n\n${table}` },
        ],
      },
    };
    expect(feishuCardWithinTableLimit(card)).toBe(true);
  });
});

describe("shouldUseCard (tables the card renderer will draw)", () => {
  const pipedTable = "| Name | Role |\n| --- | --- |\n| Ada | Lead |";
  const pipelessTable = "Name | Role\n---- | ----\nAda  | Lead";
  const quotedTable = "> Name | Role\n> ---- | ----\n> Ada  | Lead";
  const listTable = "- Name | Role\n  ---- | ----\n  Ada  | Lead";
  const orderedListTable = "1. Name | Role\n   ---- | ----\n   Ada  | Lead";

  it("promotes a table the renderer draws", () => {
    expect(shouldUseCard(pipedTable, true)).toBe(true);
    expect(shouldUseCard(pipelessTable, true)).toBe(true);
    expect(shouldUseCard("| a | b |\n|:--|--:|\n| 1 | 2 |", true)).toBe(true);
  });

  it("leaves a quoted table on the post path", () => {
    // The card renderer does not descend into the quote, so it would draw
    // neither the table nor its text. The post path converts it to a fence.
    expect(shouldUseCard(quotedTable, true)).toBe(false);
  });

  it("leaves a table opened by a list marker on the post path", () => {
    // Our parser reads the marker as part of the first header cell. The card
    // renderer reads it as a list item and draws an empty bullet.
    expect(shouldUseCard(listTable, true)).toBe(false);
    expect(shouldUseCard(orderedListTable, true)).toBe(false);
  });

  // Each of these parses to the first header cell `- Name`, exactly like the
  // list-opened table above, and none of them opens a list. Reading the parsed
  // cell instead of the source line would send all four to the post path.
  it.each([
    ["an outer pipe", "| - Name | Role |\n| --- | --- |\n| Ada | Lead |"],
    ["an escaped marker", "\\- Name | Role\n--- | ---\nAda | Lead"],
    ["an inline-code marker", "`- Name` | Role\n--- | ---\nAda | Lead"],
    ["an emphasized marker", "**- Name** | Role\n--- | ---\nAda | Lead"],
    ["an entity marker", "&#45; Name | Role\n--- | ---\nAda | Lead"],
  ])("still promotes a table whose first cell only looks like a marker: %s", (_label, text) => {
    expect(shouldUseCard(text, true)).toBe(true);
  });

  it("leaves a message mixing drawable and undrawable tables on the post path", () => {
    expect(shouldUseCard(`${pipedTable}\n\n${listTable}`, true)).toBe(false);
  });

  it("lets fenced code promote a message that also holds an undrawable table", () => {
    // Fenced code answers before tables are counted at all, so this is an
    // override rather than a table decision. The table in such a message is
    // still subject to the renderer limitation.
    expect(shouldUseCard("```js\nconst a = 1;\n```\n\n" + listTable, true)).toBe(true);
  });

  it("does not promote a table when the mode converts it first", () => {
    expect(shouldUseCard(pipedTable, false)).toBe(false);
    expect(shouldUseCard(quotedTable, false)).toBe(false);
  });

  it("does not promote prose that merely contains pipes", () => {
    expect(shouldUseCard("hello | world", true)).toBe(false);
  });
});
