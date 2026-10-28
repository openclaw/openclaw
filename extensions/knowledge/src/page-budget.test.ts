import { expect, it } from "vitest";
import type { LoadedRecord } from "./model.js";
import { HUB_PAGE_BUDGET_CHARS, pageBudgetRejection } from "./page-budget.js";

const vault = (size: number, degree: number, body = "") =>
  Array.from({ length: size }, (_, n) => ({
    id: `page-${String(n).padStart(4, "0")}`,
    title: `Page ${n}`,
    kind: "page",
    type: "note",
    path: `notes/page-${n}.md`,
    lifecycle: "active",
    valid: true,
    metadata: {},
    body: n
      ? ""
      : Array.from({ length: degree }, (_link, l) => `[[Page ${l + 1}]]\n`).join("") + body,
  })) as unknown as LoadedRecord[];
const check = (records: LoadedRecord[], after: LoadedRecord, hubPercentile = 90) =>
  pageBudgetRejection({
    changes: [{ before: records.find((r) => r.id === after.id), after }],
    records,
    current: () => records,
    hubPercentile,
  });
const hub = (records: LoadedRecord[], percentile = 90, index = 0) =>
  check(records, { ...records[index]!, body: "x".repeat(24_001) }, percentile)!.budget.pages[0]!
    .hub;

it("classifies hubs by link-degree percentile with vault-size and degree floors", () => {
  expect(hub(vault(30, 12))).toMatchObject({ hub: true, degree: 12, pages: 30 });
  expect(hub(vault(30, 12), 99).hub).toBe(false);
  // Too few pages for a meaningful percentile, or too few links to be a hub.
  expect(hub(vault(19, 12))).toMatchObject({ hub: false, degree: 12 });
  expect(hub(vault(60, 9))).toMatchObject({ hub: false, degree: 9 });
  // A backlink counts toward the target's degree.
  expect(hub(vault(30, 12), 90, 1).degree).toBe(1);
});

it("reports hub budget, nested sections outside code, and the connected pages a section names", () => {
  const prose = `## State\n${"s".repeat(500)}\n### Ledger work\nPage 1 moved. Page 1 shipped.\n\`\`\`\n# not a heading\n\`\`\`\n${"l".repeat(9000)}\n### Other\n${"o".repeat(4000)}\n`;
  const records = vault(30, 12, prose),
    before = records[0]!;
  const after = { ...before, body: before.body + "g" };
  const report = check(records, after)!.budget.pages[0]!;
  expect(report).toMatchObject({
    budgetChars: HUB_PAGE_BUDGET_CHARS,
    currentChars: before.body.length,
    attemptedChars: before.body.length + 1,
    hub: { hub: true, degree: 12 },
  });
  expect(
    report.sections.map((s) => [s.heading, s.subsections, s.candidates.map((c) => c.id)]),
  ).toStrictEqual([
    ["State", 2, ["page-0001"]],
    ["Ledger work", 0, ["page-0001"]],
    ["Other", 0, []],
  ]);
  expect(report.sections[1]!.candidates[0]).toMatchObject({ linked: false, mentions: 2 });
  // Same-size rewrites pass even over budget; claims are never budgeted.
  expect(check(records, { ...before, body: "x".repeat(before.body.length) })).toBeUndefined();
  expect(check(records, { ...after, kind: "claim" })).toBeUndefined();
});
