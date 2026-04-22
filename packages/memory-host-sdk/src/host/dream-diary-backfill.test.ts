import { describe, expect, it } from "vitest";
import { collectDreamDiaryBackfillEntries } from "./dream-diary-backfill.js";

describe("collectDreamDiaryBackfillEntries", () => {
  it("keeps durable same-day slugged notes separate even when their slugs look like summaries", () => {
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

    expect(entries).toEqual([
      {
        isoDay: "2026-04-19",
        sourcePath: "memory/2026-04-19.md",
        bodyLines: ["What Happened", "1. Canonical detail", "", "Reflections", "- Shared bullet"],
      },
      {
        isoDay: "2026-04-19",
        sourcePath: "memory/2026-04-19-reset-summary.md",
        bodyLines: [
          "What Happened",
          "1. Reset detail",
          "",
          "Reflections",
          "- Shared bullet",
          "- Reset-only bullet",
        ],
      },
    ]);
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

  it("does not cross-dedupe repeated list items across separate same-day durable notes", () => {
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

    expect(entries).toEqual([
      {
        isoDay: "2026-04-19",
        sourcePath: "memory/2026-04-19.md",
        bodyLines: ["What Happened", "- Shared bullet", "", "Reflections", "- Original reflection"],
      },
      {
        isoDay: "2026-04-19",
        sourcePath: "memory/2026-04-19-reset-summary.md",
        bodyLines: ["What Happened", "- Different detail", "", "Reflections", "- Shared bullet"],
      },
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
