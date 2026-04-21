import { describe, expect, it } from "vitest";
import { collectGroundedShortTermSeedItems } from "./grounded-short-term-seeds.js";

describe("collectGroundedShortTermSeedItems", () => {
  it("keeps repeated same-day snippets when they point at distinct lines", () => {
    const items = collectGroundedShortTermSeedItems([
      {
        path: "memory/2025-01-01.md",
        facts: [],
        reflections: [],
        renderedMarkdown: "",
        memoryImplications: [
          {
            text: 'Always use "Happy Together" calendar for flights and reservations.',
            refs: ["memory/2025-01-01.md:2"],
          },
          {
            text: 'Always use "Happy Together" calendar for flights and reservations.',
            refs: ["memory/2025-01-01.md:3"],
          },
        ],
        candidates: [],
      },
    ]);

    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => `${item.startLine}:${item.endLine}`))).toEqual(
      new Set(["2:2", "3:3"]),
    );
  });

  it("keeps same-day canonical and slugged variants as separate seed items", () => {
    const items = collectGroundedShortTermSeedItems([
      {
        path: "memory/2025-01-01.md",
        facts: [],
        reflections: [],
        renderedMarkdown: "",
        memoryImplications: [
          {
            text: 'Always use "Happy Together" calendar for flights and reservations.',
            refs: ["memory/2025-01-01.md:2"],
          },
        ],
        candidates: [],
      },
      {
        path: "memory/2025-01-01-reset-summary.md",
        facts: [],
        reflections: [],
        renderedMarkdown: "",
        memoryImplications: [
          {
            text: 'Always use "Happy Together" calendar for flights and reservations.',
            refs: ["memory/2025-01-01-reset-summary.md:2"],
          },
        ],
        candidates: [],
      },
    ]);

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.path).toSorted()).toEqual([
      "memory/2025-01-01-reset-summary.md",
      "memory/2025-01-01.md",
    ]);
  });

  it("keeps same-day snippets from different directories as separate grounded seeds", () => {
    const items = collectGroundedShortTermSeedItems([
      {
        path: "memory/daily/2025-01-01.md",
        facts: [],
        reflections: [],
        renderedMarkdown: "",
        memoryImplications: [
          {
            text: 'Always use "Happy Together" calendar for flights and reservations.',
            refs: ["memory/daily/2025-01-01.md:2"],
          },
        ],
        candidates: [],
      },
      {
        path: "memory/travel/2025-01-01.md",
        facts: [],
        reflections: [],
        renderedMarkdown: "",
        memoryImplications: [
          {
            text: 'Always use "Happy Together" calendar for flights and reservations.',
            refs: ["memory/travel/2025-01-01.md:2"],
          },
        ],
        candidates: [],
      },
    ]);

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.path).toSorted()).toEqual([
      "memory/daily/2025-01-01.md",
      "memory/travel/2025-01-01.md",
    ]);
  });

  it("keeps same-day slugged notes with the same snippet and line as separate grounded seeds", () => {
    const items = collectGroundedShortTermSeedItems([
      {
        path: "memory/2025-01-01-workshop.md",
        facts: [],
        reflections: [],
        renderedMarkdown: "",
        memoryImplications: [
          {
            text: "Shared reminder",
            refs: ["memory/2025-01-01-workshop.md:2"],
          },
        ],
        candidates: [],
      },
      {
        path: "memory/2025-01-01-travel.md",
        facts: [],
        reflections: [],
        renderedMarkdown: "",
        memoryImplications: [
          {
            text: "Shared reminder",
            refs: ["memory/2025-01-01-travel.md:2"],
          },
        ],
        candidates: [],
      },
    ]);

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.path).toSorted()).toEqual([
      "memory/2025-01-01-travel.md",
      "memory/2025-01-01-workshop.md",
    ]);
  });
});
