// Memory Core tests cover memory budget plugin behavior.
import { describe, expect, it } from "vitest";
import { compactMemoryForBudget } from "./memory-budget.js";

const PROMOTION_MARKER_LINE = "<!-- openclaw-memory-promotion:memory/short-term.md#entry -->";

function promotionSection(date: string, sizeChars: number): string {
  const heading = `## Promoted From Short-Term Memory (${date})\n`;
  const marker = `${PROMOTION_MARKER_LINE}\n`;
  const entryPrefix = "- ";
  const padding = "x".repeat(
    Math.max(0, sizeChars - heading.length - marker.length - entryPrefix.length),
  );
  return `${heading}${marker}${entryPrefix}${padding}`;
}

function markerFreeSection(date: string, body: string): string {
  return `## Promoted From Short-Term Memory (${date})\n${body}\n`;
}

// Mirrors applyMemoryConsolidationPlan: one plain entry and one lineage-tracked entry.
function consolidatedSection(date: string): string {
  return [
    "",
    `## Consolidated Memory (${date})`,
    "",
    `<!-- openclaw-memory-promotion:memory:memory/${date}.md:1:1 -->`,
    `- ${"c".repeat(120)} Source: memory/${date}.md#L1-L1`,
    `<!-- openclaw-memory-lineage:memory:memory/${date}.md:2:2 -->`,
    `<!-- openclaw-memory-promotion:memory:memory/${date}.md:3:3 -->`,
    `- ${"s".repeat(120)} Source: memory/${date}.md#L3-L3`,
  ].join("\n");
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
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 0,
    });
    expect(result.compacted).toBe(existing);
    expect(result.droppedDates).toEqual([]);
  });

  it("handles empty existing memory cleanly", () => {
    const result = compactMemoryForBudget({
      existingMemory: "",
      newSection: promotionSection("2026-04-29", 500),
      budgetChars: 100,
    });
    expect(result.compacted).toBe("");
    expect(result.droppedDates).toEqual([]);
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
    const existing =
      `${promotionSection("2026-04-10", 400)}\n` +
      userSection +
      promotionSection("2026-04-20", 400);
    const newSection = `\n${promotionSection("2026-04-29", 400)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 900,
    });
    expect(result.droppedDates).toContain("2026-04-10");
    expect(result.compacted).toContain(heading);
    expect(result.compacted).toContain(content);
  });

  it("respects writer overhead reserve so on-disk size stays inside the budget", () => {
    // Regression for greptile P2 #2: budget check previously ignored the
    // header (~20 chars) and trailing newline (1 char) the caller adds.
    const existing = `${promotionSection("2026-04-10", 1_000)}\n${promotionSection("2026-04-20", 1_000)}`;
    const newSection = `\n${promotionSection("2026-04-29", 1_000)}`;
    const budget = 2_000;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: budget,
    });
    const headerOverhead = 20; // "# Long-Term Memory\n\n"
    const trailingNewline = 1;
    expect(
      result.compacted.length + newSection.length + headerOverhead + trailingNewline,
    ).toBeLessThanOrEqual(budget);
  });

  it("preserves a user `###` section with three leading spaces under a promotion section", () => {
    const heading = "   ### Correction (added by me)";
    const existing =
      `${promotionSection("2026-04-10", 400)}\n` +
      `${heading}\nThe prod DB is db-2.corp.example, NOT db-1.\n\n` +
      promotionSection("2026-04-20", 400);
    const newSection = `\n${promotionSection("2026-04-29", 400)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 900,
    });
    expect(result.droppedDates).toContain("2026-04-10");
    expect(result.compacted).toContain(heading);
    expect(result.compacted).toContain("The prod DB is db-2.corp.example, NOT db-1.");
  });

  it("drops a multi-project promotion section whole, including its `###` project subheadings", () => {
    const existing = `${projectGroupedSection("2026-04-10")}\n${projectGroupedSection("2026-04-20")}`;
    const newSection = `\n${projectGroupedSection("2026-04-29")}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 700,
    });
    expect(result.droppedDates).toEqual(["2026-04-10", "2026-04-20"]);
    expect(result.compacted).not.toContain("### Project: alpha");
    expect(result.compacted).not.toContain("### Global");
    expect(result.compacted).not.toContain("openclaw-memory-promotion");
  });

  it("preserves an empty user heading line written under a promotion section", () => {
    const existing =
      `${promotionSection("2026-04-10", 400)}\n` +
      "###\nNotes I keep under a bare heading.\n\n" +
      promotionSection("2026-04-20", 400);
    const newSection = `\n${promotionSection("2026-04-29", 400)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 900,
    });
    expect(result.droppedDates).toContain("2026-04-10");
    expect(result.compacted).toContain("Notes I keep under a bare heading.");
  });

  it("preserves a user Setext heading under a promotion section", () => {
    const existing =
      `${promotionSection("2026-04-10", 400)}\n\n` +
      "My Durable Notes\n===\nKeep this user-authored paragraph.\n\n" +
      promotionSection("2026-04-20", 400);
    const newSection = `\n${promotionSection("2026-04-29", 400)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars: 900,
    });
    expect(result.droppedDates).toContain("2026-04-10");
    expect(result.compacted).toContain("My Durable Notes\n===");
    expect(result.compacted).toContain("Keep this user-authored paragraph.");
  });

  it("drops only a clean generated section beside a marker-free lookalike", () => {
    const userSection = markerFreeSection(
      "2026-04-10",
      "USER-AUTHORED: recovery key is paper-copy-17",
    );
    const existing = `# Long-Term Memory\n\n${userSection}\n${promotionSection("2026-04-20", 600)}`;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection: `\n${promotionSection("2026-04-29", 600)}`,
      budgetChars: 700,
    });
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
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection: `\n${promotionSection("2026-04-29", 600)}`,
      budgetChars: 400,
    });
    expect(result.droppedDates).toEqual([]);
    expect(result.compacted).toBe(existing);
  });

  it("preserves an entire mixed block when user text follows a generated entry", () => {
    const existing = [
      promotionSection("2026-04-10", 400),
      "",
      "USER-AUTHORED: keep this unheaded durable note.",
      "",
      promotionSection("2026-04-20", 400),
    ].join("\n");
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection: `\n${promotionSection("2026-04-29", 400)}`,
      budgetChars: 900,
    });
    expect(result.droppedDates).toEqual(["2026-04-20"]);
    expect(result.compacted).toContain("(2026-04-10)");
    expect(result.compacted).toContain("USER-AUTHORED: keep this unheaded durable note.");
    expect(result.compacted).not.toContain("(2026-04-20)");
  });

  it("drops the oldest consolidation section, including lineage-tracked entries (#163900)", () => {
    const existing = [
      "# Long-Term Memory",
      "",
      "- hand-written fact",
      ...["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"].map((date) =>
        consolidatedSection(date),
      ),
      "",
    ].join("\n");
    const newSection = `${consolidatedSection("2026-09-05")}\n`;
    const budgetChars = existing.length + newSection.length - 1;
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection,
      budgetChars,
      maxPriorEntryLossFraction: 0.25,
    });
    expect(result.droppedDates).toEqual(["2026-09-01"]);
    expect(result.compacted).not.toContain("(2026-09-01)");
    expect(result.compacted).toContain("- hand-written fact");
    expect(result.compacted).toContain("## Consolidated Memory (2026-09-02)");
    expect(result.compacted.length + newSection.length).toBeLessThanOrEqual(budgetChars);
  });

  it.each([
    {
      name: "user text after a consolidated entry",
      tail: ["USER-AUTHORED: keep this note."],
    },
    {
      name: "a lineage marker that no promotion entry follows",
      tail: ["<!-- openclaw-memory-lineage:memory:memory/2026-09-01.md:9:9 -->", "- user bullet"],
    },
    {
      name: "an inline note beside a lineage marker",
      tail: [
        "<!-- openclaw-memory-lineage:memory:memory/2026-09-01.md:9:9 --> <!-- USER-AUTHORED: keep this note. -->",
        "<!-- openclaw-memory-promotion:memory:memory/2026-09-01.md:9:9 -->",
        "- annotated entry",
      ],
    },
    {
      name: "an inline note beside a promotion marker",
      tail: [
        "<!-- openclaw-memory-promotion:memory:memory/2026-09-01.md:9:9 --> <!-- USER-AUTHORED: keep this note. -->",
        "- annotated entry",
      ],
    },
  ])("preserves a consolidation section holding $name", ({ tail }) => {
    const existing = [consolidatedSection("2026-09-01").trimStart(), ...tail, ""].join("\n");
    const result = compactMemoryForBudget({
      existingMemory: existing,
      newSection: `\n${promotionSection("2026-09-05", 600)}`,
      budgetChars: 400,
    });
    expect(result.droppedDates).toEqual([]);
    expect(result.compacted).toBe(existing);
  });
});
