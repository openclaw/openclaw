import { describe, expect, it } from "vitest";
import { applyConstructFallbacks } from "./construct-fallbacks.js";
import {
  FormatCapabilityProfile,
  type ConstructSupport,
  type FormatConstruct,
} from "./format-capabilities.js";
import { markdownToIR, sliceMarkdownIR, type MarkdownIR } from "./ir.js";

const ALL_NATIVE = FormatCapabilityProfile.define({
  mechanism: "markdown",
  chunk: { limit: 4_000, unit: "chars" },
});

function withSupport(
  construct: FormatConstruct,
  support: ConstructSupport,
): FormatCapabilityProfile {
  return {
    ...ALL_NATIVE,
    constructs: { ...ALL_NATIVE.constructs, [construct]: support },
  };
}

function markdownToTaskIR(markdown: string): MarkdownIR {
  return markdownToIR(markdown, { enableTaskLists: true });
}

it("preserves authored tags through projection and list-marker removal", () => {
  const parsed = markdownToIR("- **<b>x</b>**");
  const native = applyConstructFallbacks(parsed, ALL_NATIVE);
  const stripped = applyConstructFallbacks(parsed, withSupport("bulletList", "strip"));

  expect(native.htmlTags).toEqual([
    { start: 2, end: 5, raw: "<b>", name: "b", closing: false, selfClosing: false },
    { start: 6, end: 10, raw: "</b>", name: "b", closing: true, selfClosing: false },
  ]);
  expect(stripped.text).toBe("<b>x</b>");
  expect(stripped.styles).toEqual([{ start: 0, end: 8, style: "bold" }]);
  expect(stripped.htmlTags).toEqual([
    { start: 0, end: 3, raw: "<b>", name: "b", closing: false, selfClosing: false },
    { start: 4, end: 8, raw: "</b>", name: "b", closing: true, selfClosing: false },
  ]);
  expect(Object.keys(native)).not.toContain("htmlTags");
  expect(Object.keys(stripped)).not.toContain("htmlTags");
});

type FallbackCase = {
  construct: FormatConstruct;
  support: ConstructSupport;
  ir: MarkdownIR;
  expected: [text: string, styles: string[], links: number];
};

const HEADING_IR: MarkdownIR = {
  text: "Title",
  styles: [{ start: 0, end: 5, style: "heading_2" }],
  links: [],
};
const LINK_IR: MarkdownIR = {
  text: "docs",
  styles: [],
  links: [{ start: 0, end: 4, href: "https://example.com" }],
};
const CODE_IR: MarkdownIR = {
  text: "const x = 1;",
  styles: [{ start: 0, end: 12, style: "code_block", language: "ts" }],
  links: [],
};

describe("applyConstructFallbacks", () => {
  it.each<FallbackCase>([
    {
      construct: "heading",
      support: "native",
      ir: HEADING_IR,
      expected: ["Title", ["heading_2"], 0],
    },
    { construct: "heading", support: "fallback", ir: HEADING_IR, expected: ["Title", ["bold"], 0] },
    { construct: "heading", support: "strip", ir: HEADING_IR, expected: ["Title", [], 0] },
    { construct: "linkLabel", support: "native", ir: LINK_IR, expected: ["docs", [], 1] },
    { construct: "linkLabel", support: "strip", ir: LINK_IR, expected: ["docs", [], 0] },
    {
      construct: "spoiler",
      support: "strip",
      ir: { text: "secret", styles: [{ start: 0, end: 6, style: "spoiler" }], links: [] },
      expected: ["secret", [], 0],
    },
    {
      construct: "taskList",
      support: "native",
      ir: markdownToTaskIR("- [x] done"),
      expected: ["• [x] done", [], 0],
    },
    {
      construct: "codeLanguage",
      support: "native",
      ir: CODE_IR,
      expected: ["const x = 1;", ["code_block:ts"], 0],
    },
    {
      construct: "codeLanguage",
      support: "fallback",
      ir: CODE_IR,
      expected: ["const x = 1;", ["code_block"], 0],
    },
    {
      construct: "underline",
      support: "fallback",
      ir: { text: "under", styles: [{ start: 0, end: 5, style: "underline" }], links: [] },
      expected: ["under", [], 0],
    },
  ])("$construct: $support", ({ construct, support, ir, expected }) => {
    const actual = applyConstructFallbacks(ir, withSupport(construct, support));
    expect([
      actual.text,
      actual.styles.map((span) => (span.language ? `${span.style}:${span.language}` : span.style)),
      actual.links.length,
    ]).toEqual(expected);
  });

  it("keeps link suffixes outside surrounding styles", () => {
    const ir: MarkdownIR = {
      text: "see docs now",
      styles: [{ start: 0, end: 12, style: "bold" }],
      links: [{ start: 4, end: 8, href: "https://example.com" }],
    };

    expect(applyConstructFallbacks(ir, withSupport("linkLabel", "fallback"))).toEqual({
      text: "see docs (https://example.com) now",
      styles: [
        { start: 0, end: 8, style: "bold" },
        { start: 30, end: 34, style: "bold" },
      ],
      links: [],
    });
  });

  it("merges heading fallback with authored bold and respects stripped bold", () => {
    const ir: MarkdownIR = {
      text: "Title",
      styles: [
        { start: 0, end: 5, style: "heading_1" },
        { start: 0, end: 5, style: "bold" },
      ],
      links: [],
    };
    expect(applyConstructFallbacks(ir, withSupport("heading", "fallback")).styles).toEqual([
      { start: 0, end: 5, style: "bold" },
    ]);
    expect(
      applyConstructFallbacks(ir, {
        ...withSupport("heading", "fallback"),
        constructs: {
          ...ALL_NATIVE.constructs,
          heading: "fallback",
          bold: "strip",
        },
      }).styles,
    ).toEqual([]);
  });

  it("does not infer list constructs from literal code or escaped markers", () => {
    const ir = markdownToTaskIR(
      "```\n• [x] command\n1. step\n```\n\n- \\[x] literal\n\n-\n      [x] indented code",
    );
    const profile = {
      ...withSupport("taskList", "fallback"),
      constructs: {
        ...ALL_NATIVE.constructs,
        taskList: "fallback",
        orderedList: "strip",
      },
    } satisfies FormatCapabilityProfile;

    expect(applyConstructFallbacks(ir, profile).text).toBe(
      "• [x] command\n1. step\n\n• [x] literal\n\n• [x] indented code\n",
    );
  });

  it("preserves task-list provenance through IR slicing", () => {
    const ir = markdownToTaskIR("intro\n\n- [x] done");
    const task = sliceMarkdownIR(ir, ir.text.indexOf("•"), ir.text.length);
    expect(applyConstructFallbacks(task, withSupport("taskList", "fallback")).text).toBe(
      "[x] done",
    );
    const markerOnly = sliceMarkdownIR(ir, ir.text.indexOf("[x]"), ir.text.length);
    expect(applyConstructFallbacks(markerOnly, withSupport("taskList", "strip")).text).toBe("done");
  });

  it("recognizes task items nested inside blockquotes", () => {
    for (const markdown of ["> - [x] done", "- > - [x] done"]) {
      const ir = markdownToTaskIR(markdown);
      expect(
        applyConstructFallbacks(ir, withSupport("taskList", "fallback")).text,
        markdown,
      ).toContain("[x] done");
      expect(applyConstructFallbacks(ir, withSupport("taskList", "strip")).text).not.toContain(
        "[x]",
      );
    }
  });

  it("recognizes task items nested on the same source line", () => {
    const ir = markdownToTaskIR("- - [x] done");
    expect(applyConstructFallbacks(ir, withSupport("taskList", "strip")).text).toBe("• \n  • done");
  });

  it("recognizes multiline task-list markers", () => {
    const cases = [
      { markdown: "-\n  [x] done", expected: "• done" },
      { markdown: "- [x]\n  done", expected: "• \ndone" },
      { markdown: "> -\n>   [x] done", expected: "• done" },
    ];
    for (const { markdown, expected } of cases) {
      const ir = markdownToTaskIR(markdown);
      expect(applyConstructFallbacks(ir, withSupport("taskList", "strip")).text, markdown).toBe(
        expected,
      );
    }
  });

  it("does not consume list separators when stripping an empty task", () => {
    const ir = markdownToTaskIR("- [x] \n- next");
    expect(applyConstructFallbacks(ir, withSupport("taskList", "strip")).text).toBe("• \n• next");
  });

  it("preserves task markers that collide with shortcut reference links", () => {
    const ir = markdownToTaskIR("- [x] done\n\n[x]: https://example.com");
    expect(applyConstructFallbacks(ir, withSupport("taskList", "fallback")).text).toBe("[x] done");
    expect(ir.links).toEqual([]);
  });

  it("does not protect checkbox-like links after an earlier list-item block", () => {
    const markdown = "- ---\n\n  [x] done\n\n[x]: https://example.com";
    expect(markdownToIR(markdown, { enableTaskLists: true })).toEqual(markdownToIR(markdown));
  });

  it("preserves list provenance through structural clones", () => {
    const ir = structuredClone(markdownToTaskIR("- [x] done"));
    expect(applyConstructFallbacks(ir, withSupport("taskList", "fallback")).text).toBe("[x] done");
  });

  it("clips task-list provenance at partial marker slice boundaries", () => {
    const ir = markdownToTaskIR("- [x] done");
    const prefixOnly = sliceMarkdownIR(ir, 0, 2);
    expect(applyConstructFallbacks(prefixOnly, withSupport("taskList", "fallback")).text).toBe("");
    const insideListMarker = sliceMarkdownIR(ir, 1, ir.text.length);
    const stripListAndTask = {
      ...withSupport("taskList", "strip"),
      constructs: { ...ALL_NATIVE.constructs, taskList: "strip", bulletList: "strip" },
    } satisfies FormatCapabilityProfile;
    expect(applyConstructFallbacks(insideListMarker, stripListAndTask).text).toBe("done");
    for (const start of [3, 4]) {
      const sliced = sliceMarkdownIR(ir, start, ir.text.length);
      const stripped = applyConstructFallbacks(sliced, withSupport("taskList", "strip"));
      expect(stripped.text, `start=${start}`).toBe("done");
    }
  });

  it("clips trailing empty list-marker provenance during finalization", () => {
    const cases = [
      { markdown: "-", construct: "bulletList" as const },
      { markdown: "1.", construct: "orderedList" as const },
    ];
    for (const { markdown, construct } of cases) {
      const ir = markdownToIR(markdown);
      expect(applyConstructFallbacks(ir, withSupport(construct, "strip")).text, markdown).toBe("");
    }
  });
});
