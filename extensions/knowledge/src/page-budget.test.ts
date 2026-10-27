import { expect, it } from "vitest";
import { TEXT_PAGE_DEFAULT_CHARS } from "./limits.js";
import type { LoadedRecord } from "./model.js";
import {
  HUB_PAGE_BUDGET_CHARS,
  PAGE_BUDGET_CHARS,
  hubStatus,
  linkGraph,
  pageBudgetRejection,
  pageSections,
} from "./page-budget.js";

// Synthetic in-memory pages: `links` become wikilinks to other fixture page IDs.
const page = (id: string, links: string[] = [], body = "", extra: Partial<LoadedRecord> = {}) =>
  ({
    id,
    title: `Page ${id}`,
    kind: "page",
    type: "note",
    path: `notes/${id}.md`,
    lifecycle: "active",
    valid: true,
    revision: 1,
    hash: "0".repeat(64),
    raw: "",
    body: body + links.map((l) => `[[${l}]]\n`).join(""),
    metadata: {},
    ...extra,
  }) as LoadedRecord;
// One page linking to `degree` others in a partition of `size` pages.
const vault = (size: number, degree: number) => {
  const others = Array.from({ length: size - 1 }, (_, n) =>
    page(`page-${String(n).padStart(4, "0")}`),
  );
  const hub = page(
    "hub-page",
    others.slice(0, degree).map((o) => o.id),
  );
  return [hub, ...others];
};
const graphOf = (records: LoadedRecord[]) => linkGraph(records, records);

it("derives budgets from one default record read", () => {
  expect(HUB_PAGE_BUDGET_CHARS).toBe(TEXT_PAGE_DEFAULT_CHARS);
  expect(PAGE_BUDGET_CHARS).toBe(2 * TEXT_PAGE_DEFAULT_CHARS);
});

it("classifies hubs by link-degree percentile with vault-size and degree floors", () => {
  // Degree counts distinct pages linked either way: the hub links to 12 pages.
  const records = vault(30, 12);
  const hub = hubStatus(graphOf(records), "hub-page", 90);
  expect(hub).toMatchObject({ hub: true, degree: 12, pages: 30 });
  expect(hub.percentile).toBeCloseTo(96.6, 1);
  // A backlink counts toward the target's degree, so each linked page has degree 1.
  expect(hubStatus(graphOf(records), "page-0000", 90)).toMatchObject({ hub: false, degree: 1 });
  expect(hubStatus(graphOf(records), "hub-page", 99).hub).toBe(false);
  // Too few pages for a meaningful percentile, or too few links to be a hub.
  expect(hubStatus(graphOf(vault(19, 12)), "hub-page", 90)).toMatchObject({
    hub: false,
    degree: 12,
  });
  expect(hubStatus(graphOf(vault(60, 9)), "hub-page", 90)).toMatchObject({ hub: false, degree: 9 });
});

it("parses heading sections, nesting to the next equal or higher heading and skipping code", () => {
  const body =
    "Intro\n## State\nA\n### Billing\nB\n```\n# not a heading\n```\n### Search\nC\n## Timeline\nD";
  expect(
    pageSections(body).map((s) => [s.heading, s.level, body.slice(s.start, s.end)]),
  ).toStrictEqual([
    ["State", 2, "## State\nA\n### Billing\nB\n```\n# not a heading\n```\n### Search\nC\n"],
    ["Billing", 3, "### Billing\nB\n```\n# not a heading\n```\n"],
    ["Search", 3, "### Search\nC\n"],
    ["Timeline", 2, "## Timeline\nD"],
  ]);
});

const check = (
  before: LoadedRecord | undefined,
  after: LoadedRecord,
  records: LoadedRecord[] = [],
) =>
  pageBudgetRejection({
    changes: [{ before, after }],
    records,
    current: () => records,
    hubPercentile: 90,
  });
const sized = (record: LoadedRecord, chars: number, fill = "x") => ({
  ...record,
  body: record.body + fill.repeat(Math.max(0, chars - record.body.length)),
});

it("rejects growth past the budget but always allows same-size and shrinking edits (ratchet)", () => {
  const base = page("plain-page");
  const under = sized(base, 1000),
    over = sized(base, PAGE_BUDGET_CHARS + 5000);
  expect(check(under, sized(base, PAGE_BUDGET_CHARS))).toBeUndefined();
  expect(check(under, sized(base, PAGE_BUDGET_CHARS + 1))?.budget.pages[0]).toMatchObject({
    id: "plain-page",
    currentChars: 1000,
    attemptedChars: PAGE_BUDGET_CHARS + 1,
    budgetChars: PAGE_BUDGET_CHARS,
    hub: { hub: false },
    sectionsOf: "current",
  });
  // An oversized page may be rewritten at the same size or shrink, never grow.
  expect(check(over, sized(base, over.body.length, "y"))).toBeUndefined();
  expect(check(over, sized(base, over.body.length - 1))).toBeUndefined();
  expect(check(over, sized(base, over.body.length + 1))).toBeDefined();
  // Creates grow from nothing; claims are never budgeted.
  const created = check(undefined, sized(page("new-page"), PAGE_BUDGET_CHARS + 1));
  expect(created?.budget.pages[0]).toMatchObject({ id: null, sectionsOf: "attempted" });
  expect(check(undefined, { ...sized(page("claim-one"), 100_000), kind: "claim" })).toBeUndefined();
});

it("hub pages get the single-read budget and the rejection names sections and connected candidates", () => {
  const records = vault(30, 12);
  const ledger = records[1]!;
  const before = records[0]!;
  const body =
    before.body +
    "\n## State\n" +
    "s".repeat(500) +
    "\n### Ledger work\n" +
    `${ledger.title} moved. ${ledger.title} shipped.\n` +
    "l".repeat(9000) +
    "\n### Other\n" +
    "o".repeat(4000);
  const current = { ...before, body };
  const grown = { ...before, body: body + "g".repeat(200) };
  const rejected = check(current, grown, records)!;
  const report = rejected.budget.pages[0]!;
  expect(report).toMatchObject({
    budgetChars: HUB_PAGE_BUDGET_CHARS,
    hub: { hub: true, degree: 12, hubPercentile: 90, minPages: 20, minDegree: 10 },
    currentChars: body.length,
    attemptedChars: body.length + 200,
  });
  expect(report.sections.map((s) => [s.heading, s.level, s.subsections])).toStrictEqual([
    ["State", 2, 2],
    ["Ledger work", 3, 0],
    ["Other", 3, 0],
  ]);
  const ledgerSection = report.sections[1]!;
  expect(body.slice(ledgerSection.start, ledgerSection.end)).toMatch(/^### Ledger work\n/);
  expect(ledgerSection.candidates).toStrictEqual([
    {
      id: ledger.id,
      title: ledger.title,
      type: "note",
      linked: false,
      mentions: 2,
      headroomChars: PAGE_BUDGET_CHARS - ledger.body.length,
    },
  ]);
  expect(report.sections[2]!.candidates).toStrictEqual([]);
  expect(rejected.message).toMatch(/knowledge_extract_section/);
  expect(rejected.message).toMatch(/knowledge_remember/);
  // The same growth on a non-hub page of equal size fits its larger budget.
  expect(
    check(sized(page("plain-page"), body.length), sized(page("plain-page"), body.length + 200)),
  ).toBeUndefined();
});
