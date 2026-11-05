import { describe, expect, it } from "vitest";
import { compactMemoryForBudget } from "./memory-budget.js";

const PROMOTION_MARKER_LINE = "<!-- openclaw-memory-promotion:memory/short-term.md#entry -->";

function promotionSection(date: string, sizeChars: number): string {
  const prefix = `## Promoted From Short-Term Memory (${date})\n${PROMOTION_MARKER_LINE}\n- `;
  return prefix + "x".repeat(Math.max(0, sizeChars - prefix.length));
}

function projectGroupedSection(date: string): string {
  const entry = (heading: string, key: string, letter: string, lines: string) =>
    `### ${heading}\n\n<!-- openclaw-memory-promotion:memory/short-term.md#${key} -->\n- ${letter.repeat(120)} [score=0.900 signals=4 recalls=4 avg=0.900 source=memory/short-term.md:${lines}]`;
  return `\n## Promoted From Short-Term Memory (${date})\n\n${entry("Global", "global", "g", "1-2")}\n\n${entry("Project: alpha", "alpha", "a", "3-4")}\n\n`;
}

function compact(existingMemory: string, newSection: string, budgetChars: number) {
  return compactMemoryForBudget({ existingMemory, newSection, budgetChars });
}

function compactAroundUserText(userSection: string) {
  return compact(
    `${promotionSection("2026-04-10", 400)}\n${userSection}${promotionSection("2026-04-20", 400)}`,
    `\n${promotionSection("2026-04-29", 400)}`,
    900,
  );
}

describe("compactMemoryForBudget — bounded MEMORY.md compaction (regression for #73691)", () => {
  it("stops before compaction would exceed the prior-entry loss limit", () => {
    const existing = [
      promotionSection("2026-04-10", 500),
      promotionSection("2026-04-15", 500),
      promotionSection("2026-04-20", 500),
      promotionSection("2026-04-25", 500),
    ].join("\n");
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection: `\n${promotionSection("2026-04-29", 500)}`,
      budgetChars: 1_400,
      maxPriorEntryLossFraction: 0.25,
    });

    expect(result.droppedDates).toEqual(["2026-04-10"]);
    expect(result.compacted).toContain("(2026-04-15)");
    expect(result.compacted.startsWith("\n")).toBe(false);
    expect(result.compacted.startsWith("## Promoted From Short-Term Memory")).toBe(true);
  });

  it("treats budgetChars <= 0 as 'no budget' and returns existing unchanged", () => {
    const existing = promotionSection("2026-04-10", 500);
    const newSection = `\n${promotionSection("2026-04-29", 500)}`;
    expect(compact(existing, newSection, 0)).toEqual({ compacted: existing, droppedDates: [] });
  });

  it("handles empty existing memory cleanly", () => {
    expect(compact("", promotionSection("2026-04-29", 500), 100)).toEqual({
      compacted: "",
      droppedDates: [],
    });
  });

  it.each([
    ["### Global", "\nMy own global rule, not a promoted entry."],
    ["###\tCorrection", "The prod DB is db-2.corp.example, NOT db-1."],
    ["   ### Correction (added by me)", "The prod DB is db-2.corp.example, NOT db-1."],
    ["###", "Notes I keep under a bare heading."],
    ["My Durable Notes\n===", "Keep this user-authored paragraph.", "\n"],
  ])("preserves user heading %j under a promotion section", (heading, content, prefix = "") => {
    const result = compactAroundUserText(`${prefix}${heading}\n${content}\n\n`);
    expect(result.droppedDates).toContain("2026-04-10");
    expect(result.compacted).toContain(heading);
    expect(result.compacted).toContain(content);
  });

  it("respects writer overhead reserve so on-disk size stays inside the budget", () => {
    const existing = `${promotionSection("2026-04-10", 1_000)}\n${promotionSection("2026-04-20", 1_000)}`;
    const newSection = `\n${promotionSection("2026-04-29", 1_000)}`;
    const budget = 2_000;
    const result = compact(existing, newSection, budget);
    const headerOverhead = 20; // "# Long-Term Memory\n\n"
    const trailingNewline = 1;
    expect(
      result.compacted.length + newSection.length + headerOverhead + trailingNewline,
    ).toBeLessThanOrEqual(budget);
  });

  it("drops a multi-project promotion section whole, including its `###` project subheadings", () => {
    const existing = `${projectGroupedSection("2026-04-10")}\n${projectGroupedSection("2026-04-20")}`;
    const newSection = `\n${projectGroupedSection("2026-04-29")}`;
    const result = compact(existing, newSection, 700);
    expect(result.droppedDates).toEqual(["2026-04-10", "2026-04-20"]);
    expect(result.compacted).not.toContain("### Project: alpha");
    expect(result.compacted).not.toContain("### Global");
    expect(result.compacted).not.toContain("openclaw-memory-promotion");
  });

  it("drops only a clean generated section beside a marker-free lookalike", () => {
    const userSection =
      "## Promoted From Short-Term Memory (2026-04-10)\nUSER-AUTHORED: recovery key is paper-copy-17\n";
    const existing = `# Long-Term Memory\n\n${userSection}\n${promotionSection("2026-04-20", 600)}`;
    const result = compact(existing, `\n${promotionSection("2026-04-29", 600)}`, 700);
    expect(result.droppedDates).toEqual(["2026-04-20"]);
    expect(result.compacted).toContain("USER-AUTHORED: recovery key is paper-copy-17");
    expect(result.compacted).not.toContain("(2026-04-20)");
  });

  it("preserves a marker-only promotion-shaped block", () => {
    const existing = [
      "## Promoted From Short-Term Memory (2026-04-10)",
      PROMOTION_MARKER_LINE,
      "",
    ].join("\n");
    expect(compact(existing, `\n${promotionSection("2026-04-29", 600)}`, 400)).toEqual({
      droppedDates: [],
      compacted: existing,
    });
  });

  it("preserves an entire mixed block when a generated marker has a handwritten comment", () => {
    const existing = [
      promotionSection("2026-04-10", 400),
      "",
      `${PROMOTION_MARKER_LINE} <!-- USER-AUTHORED -->\n- handwritten bullet`,
      "",
      promotionSection("2026-04-20", 400),
    ].join("\n");
    const result = compact(existing, `\n${promotionSection("2026-04-29", 400)}`, 900);
    expect(result.droppedDates).toEqual(["2026-04-20"]);
    expect(result.compacted).toContain("(2026-04-10)");
    expect(result.compacted).toContain("<!-- USER-AUTHORED -->");
    expect(result.compacted).not.toContain("(2026-04-20)");
  });
});
