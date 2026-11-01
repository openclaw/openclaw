import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { describe, expect, it } from "vitest";
import { chunkFeishuMarkdown } from "./markdown.js";
import {
  buildFeishuPayloadCard,
  buildFeishuPresentationCard,
  renderFeishuReplyPayload,
  feishuCardWithinTableLimit,
  hasCardMarkdownTable,
  hasUndrawableCardTable,
  isFeishuCardWithinEnvelope,
  shouldUseCard,
} from "./presentation-card.js";

function normalized(blocks: unknown[]) {
  const presentation = normalizeMessagePresentation({ blocks } as never);
  if (!presentation) {
    throw new Error("expected valid presentation");
  }
  return presentation;
}

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

  it.each([
    { tables: "code" as const, grey: false },
    { tables: "bullets" as const, grey: true },
  ])("renders a $tables context table the card can draw", ({ tables, grey }) => {
    const tableMarkdown = "| Name | Role |\n| --- | --- |\n| Ada | Lead |";
    const presentation = normalized([{ type: "context", text: tableMarkdown }]);
    const converted = convertMarkdownTables(tableMarkdown, tables);
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

  it.each(["text block", "fallback"] as const)(
    "splits a projected %s table that outgrows the card text limit",
    (via) => {
      const header = "Quarterly revenue attainment by named account owner";
      const tableMarkdown = [
        `| ${header} | n |`,
        "| --- | --- |",
        ...Array.from({ length: 80 }, (_entry, index) => `| r${index} | ${index % 10} |`),
      ].join("\n");
      expect(tableMarkdown.length).toBeLessThanOrEqual(4000);
      expect(convertMarkdownTables(tableMarkdown, "code").length).toBeGreaterThan(4000);
      const elements = buildFeishuPresentationCard({
        presentation: normalized([
          via === "fallback" ? { type: "divider" } : { type: "text", text: tableMarkdown },
        ]),
        ...(via === "fallback" ? { fallbackText: tableMarkdown } : {}),
        renderText: (text) => convertMarkdownTables(text, "code"),
      }).body.elements as { tag: string; content?: string }[];
      const markdown = elements.filter((element) => element.tag === "markdown");
      expect(markdown.length).toBeGreaterThan(1);
      if (via === "text block") {
        expect(markdown).toHaveLength(elements.length);
      }
      for (const element of markdown) {
        expect(element.content?.length ?? 0).toBeLessThanOrEqual(4000);
        expect((element.content?.match(/^```/gmu) ?? []).length).toBe(2);
      }
      const joined = markdown.map((element) => element.content).join("");
      expect(joined).toContain(header);
      expect(joined).toContain("r0");
      expect(joined).toContain("r79");
    },
  );

  it("lists a quoted table a card cannot draw and keeps the controls", () => {
    const quoted = "> | Name | Role |\n> | --- | --- |\n> | Ada | Lead |";
    const presentation = normalized([
      { type: "text", text: quoted },
      {
        type: "buttons",
        buttons: [{ label: "Allow", action: { type: "command", command: "/ok" } }],
      },
    ]);
    const elements = buildFeishuPresentationCard({
      presentation,
      renderText: (text) => text,
      tableMode: "block",
    }).body.elements as { tag: string; content?: string }[];
    const markdown = elements.find((element) => element.tag === "markdown")?.content ?? "";
    expect(markdown).toContain("Ada");
    expect(markdown).not.toContain("| --- |");
    expect(elements.some((element) => element.tag === "button")).toBe(true);
  });

  it.each(["\n", "\r\n", "\r"])("keeps a quoted off table literal with %j line endings", (eol) => {
    const quoted = ["> | First-name | Role |", "> | --- | --- |", "> | Ada | Lead |"].join(eol);
    const presentation = normalized([{ type: "text", text: quoted }]);
    const elements = buildFeishuPresentationCard({
      presentation,
      renderText: (text) => text,
      tableMode: "off",
    }).body.elements as { tag: string; content?: string }[];
    const markdown = elements.find((element) => element.tag === "markdown")?.content ?? "";
    expect(markdown).toBe(
      ["&gt; | First-name | Role |", "&gt; | &#45;-- | --- |", "&gt; | Ada | Lead |"].join(eol),
    );
    expect(markdown).not.toContain("•");
  });

  it("splits a table block whose linear form outgrows the card text limit", () => {
    const presentation = normalized([
      {
        type: "table",
        caption: "Roster",
        headers: ["name", "detail"],
        rows: Array.from({ length: 120 }, (_entry, index) => [
          `row${index}`,
          `detail ${index} ${"d".repeat(20)}`,
        ]),
      },
    ]);
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

  it("lists a quoted table whose projection cannot survive the split", () => {
    const tableMarkdown = [
      "> | name | detail |",
      "> | --- | --- |",
      ...Array.from({ length: 40 }, (_entry, index) => `> | row${index} | d |`),
      `> | wide | ${"w".repeat(220)} |`,
    ].join("\n");
    const presentation = normalized([{ type: "text", text: tableMarkdown }]);
    const converted = convertMarkdownTables(tableMarkdown, "code");
    expect(tableMarkdown.length).toBeLessThanOrEqual(4000);
    expect(hasUndrawableCardTable(tableMarkdown)).toBe(true);
    expect(converted.length).toBeGreaterThan(4000);
    expect(converted).toContain("> ```");
    expect(hasUndrawableCardTable(converted)).toBe(false);
    const contents = (
      buildFeishuPresentationCard({
        presentation,
        renderText: (text) => convertMarkdownTables(text, "code"),
        tableMode: "code",
      }).body.elements as { tag: string; content: string }[]
    ).map((element) => element.content);
    for (const content of contents) {
      expect(content.length).toBeLessThanOrEqual(4000);
      expect((content.match(/^(?:&gt; ?)*```/gmu) ?? []).length % 2).toBe(0);
      expect(
        hasUndrawableCardTable(
          content.replace(/&gt;/gu, ">").replace(/&lt;/gu, "<").replace(/&amp;/gu, "&"),
        ),
      ).toBe(false);
    }
    const joined = contents.join("\n");
    expect(joined).toContain("\u2022");
    for (let index = 0; index < 40; index += 1) {
      expect(joined).toContain(`row${index}`);
    }
    expect(joined).toContain("wide");
  });

  it("keeps a projected context part inside the limit once the colour tag is added", () => {
    const tableMarkdown = [
      "| Region | Owner |",
      "| --- | --- |",
      ...Array.from({ length: 240 }, (_entry, i) => `| region-${i} | owner-name-${i} |`),
    ].join("\n");
    const presentation = normalized([{ type: "context", text: tableMarkdown }]);
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
      expect(element.content.length).toBeLessThanOrEqual(4000);
    }
  });

  it("projects a long presentation table before the adapter splits it", async () => {
    const tableMarkdown = [
      "| Name | Role |",
      "| --- | --- |",
      ...Array.from(
        { length: 260 },
        (_entry, i) => `| person-number-${i} | Regional Operations Lead |`,
      ),
    ].join("\n");
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
    for (const element of markdown) {
      expect((element.content?.match(/^```/gmu) ?? []).length).toBe(2);
      expect(element.content?.length ?? 0).toBeLessThanOrEqual(4000);
    }
    const joined = markdown.map((element) => element.content).join("");
    expect(joined).toContain("Name");
    expect(joined).toContain("person-number-259");
  });

  it("sizes a projected table by the length the element will carry", () => {
    const ampersands = "&".repeat(60);
    const tableMarkdown = [
      "| A | B |",
      "| --- | --- |",
      ...Array.from({ length: 120 }, () => `| ${ampersands} | x |`),
    ].join("\n");
    const presentation = normalized([{ type: "text", text: tableMarkdown }]);
    const projected = convertMarkdownTables(tableMarkdown, "code");
    expect(projected.length).toBeGreaterThan(4000);
    const elements = buildFeishuPresentationCard({
      presentation,
      renderText: (text) => convertMarkdownTables(text, "code"),
    }).body.elements as { tag: string; content: string }[];
    for (const element of elements) {
      expect(element.content.length).toBeLessThanOrEqual(4000);
      expect((element.content.match(/^```/gmu) ?? []).length).toBe(2);
    }
    expect(elements.map((element) => element.content).join("")).toContain("&amp;");
  });
});

describe("presentation tables across card elements", () => {
  const tableOf = (count: number, tag = "A") => [
    `| Name | ${tag}Role |`,
    "| --- | --- |",
    ...Array.from(
      { length: count },
      (_row, index) => `| ${tag}-person-${index} | Regional Operations Lead |`,
    ),
  ];
  const proseOf = (length: number) =>
    Array.from({ length: Math.ceil(length / 40) }, (_line, index) => `Prose line ${index} goes on.`)
      .join("\n")
      .slice(0, length);
  const startsOnOrphan = (content: string) => {
    const [first = "", second = ""] = content.split("\n");
    return first.startsWith("|") && !/^\|[ :|-]*-[ :|-]*\|$/u.test(second);
  };

  function cardFor(text: string) {
    const card = buildFeishuPresentationCard({
      presentation: presentationOf([text]),
      renderText: (value) => value,
      tableMode: "block",
    });
    const elements = card.body.elements as { tag: string; content?: string }[];
    const contents = elements.flatMap((element) =>
      element.tag === "markdown" ? [element.content ?? ""] : [],
    );
    return { card, contents };
  }

  it("keeps a table that fits one element whole when the cut would have landed inside it", () => {
    const table = tableOf(60).join("\n");
    expect(table.length).toBeGreaterThan(2000);
    expect(table.length).toBeLessThan(4000);
    const { card, contents } = cardFor(`${proseOf(3000)}\n\n${table}\n\n${proseOf(3000)}`);
    const holders = contents.filter((content) => content.includes(table));
    expect(holders.length).toBe(1);
    expect(hasCardMarkdownTable(holders[0] ?? "")).toBe(true);
    expect(contents.filter(startsOnOrphan)).toEqual([]);
    expect(feishuCardWithinTableLimit(card)).toBe(true);
  });

  it("cuts between two identical tables when only the first would have been cut", () => {
    const table = tableOf(55).join("\n");
    const { contents } = cardFor(`${proseOf(1900)}\n\n${table}\n\n${table}`);
    expect(contents.filter((content) => content.includes(table)).length).toBe(2);
    expect(contents.filter(startsOnOrphan)).toEqual([]);
  });

  it("repeats the header and delimiter inside a fence on every piece of an oversized table", () => {
    const { card, contents } = cardFor(`${proseOf(500)}\n\n${tableOf(300).join("\n")}\n\nEnd.`);
    const pieces = contents.filter((content) => content.includes("| A-person-"));
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.startsWith("```\n| Name | ARole |\n| --- | --- |\n")).toBe(true);
      expect(piece.endsWith("\n```")).toBe(true);
    }
    for (const content of contents) {
      expect(content.length).toBeLessThanOrEqual(4000);
      expect(hasCardMarkdownTable(content)).toBe(false);
    }
    expect(feishuCardWithinTableLimit(card)).toBe(true);
  });

  it("fences an oversized table with a run longer than any backtick run in it", () => {
    const rows = Array.from({ length: 300 }, (_row, index) => `| ${index} | \`\`\`code\`\`\` |`);
    const { contents } = cardFor(["| n | cell |", "| --- | --- |", ...rows].join("\n"));
    expect(contents.length).toBeGreaterThan(1);
    for (const content of contents) {
      expect(content.startsWith("````\n| n | cell |\n| --- | --- |\n")).toBe(true);
      expect(content.endsWith("\n````")).toBe(true);
    }
  });

  it("lists an oversized quoted table on the projection path instead of cutting its rows", async () => {
    const quoted = tableOf(120)
      .map((line) => `> ${line}`)
      .join("\n");
    expect(quoted.length).toBeGreaterThan(4000);
    const { card } = await renderFeishuReplyPayload(
      { text: "", presentation: { blocks: [{ type: "text", text: quoted }] } } as never,
      { to: "chat_1", renderText: (text: string) => text, tableMode: "block" } as never,
    );

    const markdown = ((card?.body?.elements ?? []) as { tag: string; content?: string }[]).flatMap(
      (element) => (element.tag === "markdown" ? [element.content ?? ""] : []),
    );
    expect(markdown.length).toBeGreaterThan(1);
    expect(markdown.filter((content) => /^>? ?\|/mu.test(content))).toEqual([]);
    expect(markdown.join("\n")).toContain("A-person-119");
  });

  it.each(
    [20, 70, 160, 330].flatMap((rows) =>
      [0, 1500, 3600].flatMap((before) => [0, 3000].map((after) => ({ rows, before, after }))),
    ),
  )(
    "never starts an element on an orphan row ($rows rows, $before before, $after after)",
    ({ rows, before, after }) => {
      const text = [
        before ? proseOf(before) : "",
        tableOf(rows).join("\n"),
        after ? proseOf(after) : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const { card, contents } = cardFor(text);
      expect(contents.filter(startsOnOrphan)).toEqual([]);
      expect(contents.filter((content) => content.length > 4000)).toEqual([]);
      expect(feishuCardWithinTableLimit(card)).toBe(true);
      const joined = contents.join("\n");
      let at = 0;
      let ordered = true;
      for (let row = 0; row < rows; row += 1) {
        const found = joined.indexOf(`| A-person-${row} |`, at);
        ordered &&= found >= at;
        at = Math.max(at, found);
      }
      expect(ordered).toBe(true);
      expect(joined.split("| A-person-").length - 1).toBe(rows);
    },
  );

  const wideTable = (tag: string, header: number, rows: number) =>
    [
      `| Name | ${tag}${"H".repeat(header)} |`,
      "| --- | --- |",
      ...Array.from({ length: rows }, (_row, index) => `| ${tag}-person-${index} | x |`),
    ].join("\n");
  const admitted = (card: Record<string, unknown>) =>
    isFeishuCardWithinEnvelope(card) && feishuCardWithinTableLimit(card);
  const identity = (value: string) => value;
  function presentationOf(texts: string[]) {
    return normalized([
      ...texts.map((text) => ({ type: "text", text })),
      { type: "buttons", buttons: [{ label: "Ok", action: { type: "command", command: "/ok" } }] },
    ]);
  }
  const rawCutCard = (texts: string[]) =>
    buildFeishuPresentationCard({
      presentation: presentationOf(texts.flatMap((text) => chunkFeishuMarkdown(text, 4_000))),
      renderText: identity,
      tableMode: "block",
    });
  const markdownOf = (card: { body: { elements: unknown[] } }) =>
    (card.body.elements as { tag: string; content?: string }[]).flatMap((element) =>
      element.tag === "markdown" ? [(element.content ?? "").trimEnd()] : [],
    );

  it("never loses a card the raw cut delivered, however wide the header", () => {
    const lost: string[] = [];
    let fenced = 0;
    let rawKept = 0;
    for (const header of [6, 500, 1_500, 3_500]) {
      for (const rows of [40, 120, 200, 500]) {
        for (const after of [0, 4_000]) {
          const table = wideTable("A", header, rows);
          const text = after ? `${table}\n\n${proseOf(after)}` : table;
          if (!admitted(rawCutCard([text]))) {
            continue;
          }
          const delivered = buildFeishuPayloadCard({
            payload: { presentation: presentationOf([text]) },
            renderText: identity,
            tableMode: "block",
          });
          if (!delivered) {
            lost.push(`${header} header, ${rows} rows, ${after} after`);
            continue;
          }
          fenced += markdownOf(delivered).some((content) => content.startsWith("```")) ? 1 : 0;
          rawKept += markdownOf(delivered).some(startsOnOrphan) ? 1 : 0;
        }
      }
    }
    expect(lost).toEqual([]);
    expect(fenced).toBeGreaterThan(0);
    expect(rawKept).toBeGreaterThan(0);
  });

  it("keeps the raw cut when several moderate repeated headers together outgrow the card", () => {
    const tables = ["A", "B", "C", "D", "E"].map((tag) => wideTable(tag, 1_500, 200));
    const presentation = presentationOf([tables.join("\n\n")]);
    const safe = buildFeishuPresentationCard({
      presentation,
      renderText: identity,
      tableMode: "block",
      rawTableCut: false,
    });
    const raw = rawCutCard([tables.join("\n\n")]);
    expect(admitted(safe)).toBe(false);
    expect(admitted(raw)).toBe(true);
    const delivered = buildFeishuPayloadCard({
      payload: { presentation },
      renderText: identity,
      tableMode: "block",
    });

    expect(delivered && markdownOf(delivered)).toEqual(markdownOf(raw));
    expect(delivered?.body.elements.some((element) => element.tag === "button")).toBe(true);
  });

  it("keeps the raw cut when a header and one row cannot share an element", () => {
    const table = [
      `| Name | ${"H".repeat(2_000)} |`,
      "| --- | --- |",
      ...[0, 1].map((index) => `| person-${index} | ${"x".repeat(2_100)} |`),
    ].join("\n");
    const { card, contents } = cardFor(table);
    expect(2_000 + 2_100 + "| Name |  |\n| --- | --- |\n```\n```".length).toBeGreaterThan(4_000);
    expect(admitted(card)).toBe(true);
    expect(card.body.elements.some((element) => element.tag === "button")).toBe(true);
    expect(contents.map((content) => content.trimEnd())).toEqual(markdownOf(rawCutCard([table])));
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThan(7_000);
  });

  it("builds the card that will be delivered unless a cut is asked for", () => {
    const table = wideTable("W", 3_500, 200);
    const params = {
      presentation: presentationOf([table]),
      renderText: identity,
      tableMode: "block" as const,
    };
    const built = buildFeishuPresentationCard(params);
    expect(admitted(built)).toBe(true);
    expect(markdownOf(built)).toEqual(markdownOf(rawCutCard([table])));
    expect(admitted(buildFeishuPresentationCard({ ...params, rawTableCut: false }))).toBe(false);
    expect(markdownOf(buildFeishuPresentationCard({ ...params, rawTableCut: true }))).toEqual(
      markdownOf(built),
    );
  });

  it("weighs the repeated headers against the card with its mentions", () => {
    const mentions = Array.from({ length: 20 }, (_mention, index) => ({
      openId: `ou_${"x".repeat(24)}${String(index).padStart(3, "0")}`,
      name: `User${index}`,
      key: `@_user_${index}`,
    }));
    const filler = [...Array.from({ length: 5 }, () => "p".repeat(3_900)), "p".repeat(500)];
    const presentation = presentationOf([wideTable("T", 900, 300), ...filler]);
    const raw = rawCutCard([wideTable("T", 900, 300), ...filler]);
    expect(
      admitted(
        buildFeishuPresentationCard({
          presentation,
          renderText: identity,
          tableMode: "block",
          rawTableCut: false,
        }),
      ),
    ).toBe(true);
    const delivered = buildFeishuPayloadCard({
      payload: { presentation },
      mentions,
      renderText: identity,
      tableMode: "block",
    });

    expect(delivered && markdownOf(delivered).slice(1)).toEqual(markdownOf(raw));
  });
});

describe("isFeishuCardWithinEnvelope", () => {
  it("rejects cyclic cards at the serialization boundary", () => {
    const card: Record<string, unknown> = { schema: "2.0" };
    card.body = card;
    expect(isFeishuCardWithinEnvelope(card)).toBe(false);
  });

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
});

describe("shouldUseCard (tables the card renderer will draw)", () => {
  const orderedListTable = "1. Name | Role\n   ---- | ----\n   Ada  | Lead";

  it("promotes a compact aligned table with two-hyphen delimiters", () => {
    expect(shouldUseCard("| a | b |\n|:--|--:|\n| 1 | 2 |", true)).toBe(true);
  });

  it("leaves a table opened by an ordered list marker on the post path", () => {
    expect(shouldUseCard(orderedListTable, true)).toBe(false);
  });

  it.each([
    ["an outer pipe", "| - Name | Role |\n| --- | --- |\n| Ada | Lead |"],
    ["an escaped marker", "\\- Name | Role\n--- | ---\nAda | Lead"],
    ["an inline-code marker", "`- Name` | Role\n--- | ---\nAda | Lead"],
    ["an emphasized marker", "**- Name** | Role\n--- | ---\nAda | Lead"],
    ["an entity marker", "&#45; Name | Role\n--- | ---\nAda | Lead"],
  ])("still promotes a table whose first cell only looks like a marker: %s", (_label, text) => {
    expect(shouldUseCard(text, true)).toBe(true);
  });

  it("does not promote prose that merely contains pipes", () => {
    expect(shouldUseCard("hello | world", true)).toBe(false);
  });
});
