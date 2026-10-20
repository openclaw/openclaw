import { describe, expect, it } from "vitest";
import { compactMemoryForBudget } from "./memory-budget.js";

const PROMOTION_MARKER_LINE = "<!-- openclaw-memory-promotion:memory/short-term.md#entry -->";

function promotionSection(date: string, sizeChars: number): string {
  const prefix = `## Promoted From Short-Term Memory (${date})\n${PROMOTION_MARKER_LINE}\n- `;
  return prefix + "x".repeat(Math.max(0, sizeChars - prefix.length));
}

function projectGroupedSection(date: string): string {
  return [
    "",
    `## Promoted From Short-Term Memory (${date})`,
    "",
    "### Global",
    "",
    "<!-- openclaw-memory-promotion:memory/short-term.md#global -->",
    `- ${"g".repeat(120)} [score=0.900 signals=4 recalls=4 avg=0.900 source=memory/short-term.md:1-2]`,
    "",
    "### Project: alpha",
    "",
    "<!-- openclaw-memory-promotion:memory/short-term.md#alpha -->",
    `- ${"a".repeat(120)} [score=0.900 signals=4 recalls=4 avg=0.900 source=memory/short-term.md:3-4]`,
    "",
    "",
  ].join("\n");
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
    {
      title: "preserves a user-authored `### Global` heading written under a promotion section",
      userSection: "### Global\n\nMy own global rule, not a promoted entry.\n\n",
      heading: "### Global",
      content: "My own global rule, not a promoted entry.",
    },
    {
      title: "preserves a tab-delimited user heading written under a promotion section",
      userSection: "###\tCorrection\nThe prod DB is db-2.corp.example, NOT db-1.\n\n",
      heading: "###\tCorrection",
      content: "The prod DB is db-2.corp.example, NOT db-1.",
    },
  ])("$title", ({ userSection, heading, content }) => {
    const result = compactAroundUserText(userSection);
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

  it("preserves a user `###` section with three leading spaces under a promotion section", () => {
    const heading = "   ### Correction (added by me)";
    const result = compactAroundUserText(
      `${heading}\nThe prod DB is db-2.corp.example, NOT db-1.\n\n`,
    );
    expect(result.droppedDates).toContain("2026-04-10");
    expect(result.compacted).toContain(heading);
    expect(result.compacted).toContain("The prod DB is db-2.corp.example, NOT db-1.");
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

  it("preserves an empty user heading line written under a promotion section", () => {
    const result = compactAroundUserText("###\nNotes I keep under a bare heading.\n\n");
    expect(result.droppedDates).toContain("2026-04-10");
    expect(result.compacted).toContain("Notes I keep under a bare heading.");
  });

  it("preserves a user Setext heading under a promotion section", () => {
    const result = compactAroundUserText(
      "\nMy Durable Notes\n===\nKeep this user-authored paragraph.\n\n",
    );
    expect(result.droppedDates).toContain("2026-04-10");
    expect(result.compacted).toContain("My Durable Notes\n===");
    expect(result.compacted).toContain("Keep this user-authored paragraph.");
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

  it("preserves an entire mixed block when user text follows a generated entry", () => {
    const existing = [
      promotionSection("2026-04-10", 400),
      "",
      "USER-AUTHORED: keep this unheaded durable note.",
      "",
      promotionSection("2026-04-20", 400),
    ].join("\n");
    const result = compact(existing, `\n${promotionSection("2026-04-29", 400)}`, 900);
    expect(result.droppedDates).toEqual(["2026-04-20"]);
    expect(result.compacted).toContain("(2026-04-10)");
    expect(result.compacted).toContain("USER-AUTHORED: keep this unheaded durable note.");
    expect(result.compacted).not.toContain("(2026-04-20)");
  });
});
