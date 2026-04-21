import { describe, expect, it } from "vitest";
import { collectDreamDiaryBackfillEntries } from "./dream-diary-backfill.js";

describe("collectDreamDiaryBackfillEntries", () => {
  it("merges same-day variants and deduplicates repeated list items", () => {
    const entries = collectDreamDiaryBackfillEntries({
      files: [
        {
          path: "memory/2026-04-19.md",
          renderedMarkdown: [
            "## What Happened",
            "1. Canonical detail",
            "",
            "## Reflections",
            "- Shared bullet",
          ].join("\n"),
        },
        {
          path: "memory/2026-04-19-reset-summary.md",
          renderedMarkdown: [
            "## What Happened",
            "1. Reset detail",
            "",
            "## Reflections",
            "- Shared bullet",
            "- Reset-only bullet",
          ].join("\n"),
        },
      ],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      isoDay: "2026-04-19",
      sourcePath: undefined,
    });
    expect(entries[0]?.bodyLines).toEqual(
      expect.arrayContaining([
        "What Happened",
        "1. Canonical detail",
        "1. Reset detail",
        "Reflections",
        "- Shared bullet",
        "- Reset-only bullet",
      ]),
    );
    expect(entries[0]?.bodyLines.filter((line) => line === "- Shared bullet")).toHaveLength(1);
  });

  it("keeps the resolved source path for single-file diary backfill entries", () => {
    const entries = collectDreamDiaryBackfillEntries({
      files: [
        {
          path: "memory/2026-04-19.md",
          renderedMarkdown: ["## What Happened", "1. Durable detail"].join("\n"),
        },
      ],
      resolveSourcePath: () => "/original/2026-04-19.md",
    });

    expect(entries).toEqual([
      {
        isoDay: "2026-04-19",
        sourcePath: "/original/2026-04-19.md",
        bodyLines: ["What Happened", "1. Durable detail"],
      },
    ]);
  });

  it("preserves repeated list items when they belong to different same-day sections", () => {
    const entries = collectDreamDiaryBackfillEntries({
      files: [
        {
          path: "memory/2026-04-19.md",
          renderedMarkdown: [
            "## What Happened",
            "- Shared bullet",
            "",
            "## Reflections",
            "- Original reflection",
          ].join("\n"),
        },
        {
          path: "memory/2026-04-19-reset-summary.md",
          renderedMarkdown: [
            "## What Happened",
            "- Different detail",
            "",
            "## Reflections",
            "- Shared bullet",
          ].join("\n"),
        },
      ],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.bodyLines).toEqual([
      "What Happened",
      "- Shared bullet",
      "",
      "Reflections",
      "- Original reflection",
      "",
      "What Happened",
      "- Different detail",
      "",
      "Reflections",
      "- Shared bullet",
    ]);
  });

  it("keeps independent same-day topic notes as separate backfill entries", () => {
    const entries = collectDreamDiaryBackfillEntries({
      files: [
        {
          path: "memory/2026-04-19-travel.md",
          renderedMarkdown: ["## Travel", "- Flight moved to 7pm"].join("\n"),
        },
        {
          path: "memory/2026-04-19-workshop.md",
          renderedMarkdown: ["## Workshop", "- Bring slides"].join("\n"),
        },
      ],
    }).toSorted((left, right) => (left.sourcePath ?? "").localeCompare(right.sourcePath ?? ""));

    expect(entries).toEqual([
      {
        isoDay: "2026-04-19",
        sourcePath: "memory/2026-04-19-travel.md",
        bodyLines: ["Travel", "- Flight moved to 7pm"],
      },
      {
        isoDay: "2026-04-19",
        sourcePath: "memory/2026-04-19-workshop.md",
        bodyLines: ["Workshop", "- Bring slides"],
      },
    ]);
  });
});
