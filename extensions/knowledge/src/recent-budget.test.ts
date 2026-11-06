import { DatabaseSync } from "node:sqlite";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { hostJsonBoundary } from "./host-json-test-support.js";
import { recentActivity } from "./recent-activity.js";
import { RecentOutput } from "./recent.js";
import { afterTest, jsonRoundTrip } from "./test-support.js";
// Exercise the host's actual boundary through the SDK, not a copy of our budget helper.
// records-budget.test.ts proves this boundary rejects oversized values.
const isHostJson = hostJsonBoundary();

function fixture(
  groups: any,
  count: any,
  evidenceCount = 10,
  body = "Synthetic claim.",
  quote = "",
) {
  const db = new DatabaseSync(":memory:");
  afterTest(() => db.close());
  db.exec(`CREATE TABLE history(sequence INTEGER PRIMARY KEY, scope TEXT,id TEXT,hash TEXT,revision INTEGER,provenance TEXT,at TEXT);
    CREATE TABLE mutations(scope TEXT,state TEXT,request TEXT,receipt TEXT,plan TEXT);
    CREATE TABLE recent_requests_v1(scope TEXT,request TEXT,operation TEXT,target_id TEXT,at TEXT,reason TEXT,replacement_id TEXT, PRIMARY KEY(scope,request));
    CREATE TABLE recent_records_v1(scope TEXT,request TEXT,ordinal INTEGER,id TEXT,hash TEXT,revision,actor TEXT,kind TEXT,type TEXT,title TEXT, PRIMARY KEY(scope,request,ordinal));`);
  const active: any = [],
    at = "2026-10-01T00:00:00Z";
  const add = (id: any, kind: any, type: any, extra = {}) => {
    const record = {
      id,
      title: id,
      kind,
      type,
      path: `${id}.md`,
      lifecycle: "active",
      revision: 1,
      valid: true,
      hash: "a".repeat(64),
      raw: "",
      body,
      metadata: { recorded_at: at, updated_at: at, ...extra },
    };
    active.push(record);
    db.prepare("INSERT INTO history VALUES (?,?,?,?,?,?,?)").run(
      active.length,
      "shared",
      id,
      record.hash,
      1,
      "test",
      at,
    );
    return record;
  };
  for (let g = 0; g < groups; g++) {
    const source = add(`source-${g}`, "page", "meeting");
    for (let c = 0; c < count; c++) {
      add(`claim-${g}-${c}`, "claim", "fact", {
        source_page: source.id,
        claim_kind: "fact",
        assertion_origin: "source",
        attribution_confidence: {
          level: "medium",
          basis: "Synthetic evidence",
          evidence: Array.from({ length: evidenceCount }, () => ({
            path: "sources/sample.txt",
            sha256: "b".repeat(64),
            start_line: 1,
            end_line: 2,
            ...(quote ? { quote } : {}),
          })),
        },
      });
    }
  }
  return { db, active };
}
async function valid(value: any) {
  const json = jsonRoundTrip(value);
  expect(Check(RecentOutput, json), "Recent schema").toBeTruthy();
  expect(await isHostJson(json), "real host JSON limit").toBeTruthy();
  return json;
}

for (const [name, evidenceCount, body] of [
  ["nodes", 10, "Synthetic claim."],
  ["bytes", 1, "界".repeat(4000)],
] as const) {
  it(`Recent paginates ${name} without skipping or duplicating source groups`, async () => {
    const { db, active } = fixture(10, 20, evidenceCount, body);
    const seen = [];
    let beforeSequence, upperSequence;
    do {
      const page = await valid(
        recentActivity(db, "shared", active, {
          groupBySource: true,
          includeEndpoints: true,
          limit: 50,
          beforeSequence,
          upperSequence,
        }),
      );
      expect(page.items.length > 0 && page.items.length < 10).toBeTruthy();
      seen.push(...page.items.map((item: any) => item.group.source.id));
      beforeSequence = page.nextBefore;
      upperSequence = page.upperSequence;
    } while (beforeSequence != null);
    expect(seen.length).toBe(10);
    expect(new Set(seen).size).toBe(10);
  });
}

for (const quote of ["", "界".repeat(4000)]) {
  it(`oversized source uses inner continuation${quote ? " with summary-only fallback" : ""}`, async () => {
    const { db, active } = fixture(1, 25, 20, "Synthetic claim.", quote);
    const seen = [];
    let recordOffset = 0,
      upperSequence;
    do {
      const page = await valid(
        recentActivity(db, "shared", active, {
          groupBySource: true,
          includeEndpoints: true,
          sourceId: "source-0",
          recordOffset,
          upperSequence,
        }),
      );
      const group = page.items[0].group;
      expect(group.records.length > 0).toBeTruthy();
      expect(page.nextBefore).toBe(null);
      seen.push(...group.records.map((r: any) => r.id));
      if (recordOffset === 0 && quote) {
        expect(group.records[0].card, "huge preview becomes clickable summary").toBe(undefined);
      }
      recordOffset = group.nextRecordOffset;
      upperSequence = page.upperSequence;
      expect(group.truncated).toBe(recordOffset != null);
    } while (recordOffset != null);
    expect(seen.length).toBe(26);
    expect(new Set(seen).size).toBe(26);
  });
}
