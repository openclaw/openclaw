// Telegram rich message: structured spec builder.
//
// These tests exercise the new `buildTelegramRichMarkdownFromSpec` helper
// which lets callers compose a rich message from a structured spec (heading,
// table, list, checklist, details) without hand-writing markdown. The spec
// is compiled into canonical markdown and then routed through the existing
// markdown → html pipeline, so escaping, chunking, and structural limits
// are inherited unchanged.

import { describe, expect, it } from "vitest";
import {
  buildTelegramRichMarkdownFromSpec,
  type TelegramRichMessageSpec,
} from "./rich-message.js";

function htmlOf(spec: TelegramRichMessageSpec): string {
  const rich = buildTelegramRichMarkdownFromSpec(spec);
  if (!rich.markdown) {
    throw new Error("expected markdown path for spec builder");
  }
  return rich.markdown;
}

describe("buildTelegramRichMarkdownFromSpec", () => {
  it("compiles a heading with default level 2", () => {
    const out = htmlOf({ heading: "Sprint Status" });
    expect(out).toContain("## Sprint Status");
  });

  it("respects heading_level and clamps to [1, 6]", () => {
    // Cast through Partial<spec> to exercise the runtime clamp; the public type
    // intentionally narrows heading_level to a literal union.
    const outOfRange = (level: number): TelegramRichMessageSpec => ({
      heading: "T",
      heading_level: level as unknown as 1 | 2 | 3 | 4 | 5 | 6,
    });
    expect(htmlOf(outOfRange(1))).toContain("# T");
    expect(htmlOf(outOfRange(6))).toContain("###### T");
    expect(htmlOf(outOfRange(9))).toContain("###### T");
    expect(htmlOf(outOfRange(0))).toContain("# T");
  });

  it("renders a real table", () => {
    const out = htmlOf({
      table: { columns: ["Task", "Status"], rows: [["Ship", "Done"]] },
    });
    expect(out).toMatch(/\| Task \| Status \|/);
    expect(out).toMatch(/\| --- \| --- \|/);
    expect(out).toMatch(/\| Ship \| Done \|/);
  });

  it("escapes pipe characters inside table cells", () => {
    const out = htmlOf({
      table: { columns: ["A", "B"], rows: [["x|y", "z"]] },
    });
    expect(out).toContain("x\\|y");
    // The cell must NOT introduce a new column.
    expect(out).not.toMatch(/\| x\|y \|/);
  });

  it("pads short rows and truncates long rows to the column count", () => {
    const out = htmlOf({
      table: { columns: ["A", "B"], rows: [["only-one", "x", "y", "z"]] },
    });
    expect(out).toMatch(/\| only-one \| x \|/);
  });

  it("throws on a table with no columns", () => {
    expect(() =>
      buildTelegramRichMarkdownFromSpec({ table: { columns: [], rows: [] } }),
    ).toThrow(/table\.columns must be non-empty/);
  });

  it("renders a list as a markdown bullet list", () => {
    const out = htmlOf({ list: [{ text: "alpha" }, { text: "beta" }] });
    expect(out).toMatch(/^- alpha$/m);
    expect(out).toMatch(/^- beta$/m);
  });

  it("renders a checklist with x / space checkboxes", () => {
    const out = htmlOf({
      checklist: [
        { text: "done", done: true },
        { text: "todo", done: false },
      ],
    });
    expect(out).toMatch(/^- \[x\] done$/m);
    expect(out).toMatch(/^- \[ \] todo$/m);
  });

  it("renders details blocks as native <details>/<summary>", () => {
    const out = htmlOf({
      details: [{ summary: "Risks", blocks: ["QA may slip", "Routes blocked"] }],
    });
    expect(out).toContain("<details>");
    expect(out).toContain("<summary>Risks</summary>");
    expect(out).toContain("QA may slip");
    expect(out).toContain("Routes blocked");
  });

  it("renders quotes as markdown blockquotes", () => {
    const out = htmlOf({ quotes: ["first", "second"] });
    expect(out).toMatch(/^> first$/m);
    expect(out).toMatch(/^> second$/m);
  });

  it("renders a divider", () => {
    const out = htmlOf({ divider: true });
    expect(out).toContain("---");
  });

  it("composes a multi-section message in a stable order", () => {
    const out = htmlOf({
      heading: "Title",
      summary: "Summary line",
      table: { columns: ["A", "B"], rows: [["1", "2"]] },
      list: [{ text: "step" }],
      quotes: ["q"],
      divider: true,
    });
    const headingIdx = out.indexOf("## Title");
    const summaryIdx = out.indexOf("Summary line");
    const tableIdx = out.indexOf("| A | B |");
    const listIdx = out.indexOf("- step");
    const quoteIdx = out.indexOf("> q");
    const dividerIdx = out.indexOf("---");
    expect(headingIdx).toBeLessThan(summaryIdx);
    expect(summaryIdx).toBeLessThan(tableIdx);
    expect(tableIdx).toBeLessThan(listIdx);
    expect(listIdx).toBeLessThan(quoteIdx);
    expect(quoteIdx).toBeLessThan(dividerIdx);
  });

  it("honors skipEntityDetection when provided", () => {
    const rich = buildTelegramRichMarkdownFromSpec(
      { heading: "T" },
      { skipEntityDetection: true },
    );
    expect(rich.skip_entity_detection).toBe(true);
  });

  it("escapes HTML in user-provided strings via the downstream pipeline", () => {
    const out = htmlOf({ heading: "<script>alert(1)</script>" });
    // The downstream markdownToTelegramRichHtml should escape the angle brackets.
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
});
