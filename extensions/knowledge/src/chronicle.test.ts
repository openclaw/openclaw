import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { stringify } from "yaml";
import type { SinceInput, TimelineInput } from "./chronicle-contract.js";
import { contract } from "./contract.js";
import { createKnowledgeService } from "./service.js";
import { returnedRecords } from "./session-activity.js";
import { dateInterval, timeBounds } from "./temporal-query.js";
import {
  hostApi,
  storeFixture,
  toolContext,
  operatorContext,
  afterTest,
  useTestTempDirs,
  defaultOrder,
} from "./test-support.js";

const tempDirs = useTestTempDirs();

async function fixture() {
  const base = tempDirs.make("knowledge-chronicle-");

  const f = await storeFixture(base, { policy: { writesEnabled: true, operatorRead: true } });
  const owner = toolContext(f.api),
    operator = operatorContext(f.api, ["operator.read"]);
  const service = createKnowledgeService(f.api);
  const artifact = "Source says the review occurred and the task was accepted.\n";
  const evidence = [
    {
      path: "artifacts/source.txt",
      sha256: createHash("sha256").update(artifact).digest("hex"),
      start_line: 1,
      end_line: 1,
    },
  ];
  async function put(
    id: any,
    metadata: { kind?: string; type?: string; [field: string]: unknown } = {},
    partition = "private",
    body = "Launch review evidence",
  ) {
    const kind = metadata.kind ?? "page",
      type = metadata.type ?? "note";
    const dir =
      kind === "claim"
        ? "claims"
        : type === "meeting"
          ? "meetings"
          : type === "person"
            ? "people"
            : "notes";
    await mkdir(path.join(f.root, partition, "artifacts"), { recursive: true });
    await writeFile(path.join(f.root, partition, "artifacts/source.txt"), artifact);
    const m = {
      format: "knowledge-record-v1",
      id,
      revision: 1,
      kind,
      type,
      title: id,
      fields: {},
      scope:
        partition === "private"
          ? { visibility: "private" }
          : { visibility: "conversation", sessionId: partition.split("/")[1] },
      recorded_at: "2026-10-04T12:00:00Z",
      updated_at: "2026-10-04T12:00:00Z",
      lifecycle: "active",
      ...(kind === "claim"
        ? {
            claim_kind: "event",
            assertion_origin: "source",
            attribution: "Retained source",
            evidence,
          }
        : {}),
      ...metadata,
    };
    const file = path.join(f.root, partition, dir, id + ".md");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "---\n" + stringify(m) + "---\n" + body);
    return file;
  }
  return { ...f, owner, operator, service, put };
}
const ids = (r: any) => r.items.map((x: any) => x.record.id);
const event = (occurred_at: any, more = {}) => ({ kind: "claim", occurred_at, ...more });

it("date validation, inclusive UTC days and date-only precision", () => {
  expect(() => dateInterval("2025-02-29")).toThrow(/real/);
  expect(() => dateInterval("2026-10-04T12:00:00")).toThrow(/timezone/);
  expect(() => timeBounds({ since: "2026-10-05", until: "2026-10-04" })).toThrow(/since/);
  expect(dateInterval("2026-10-04").end).toBe(Date.parse("2026-10-04T23:59:59.999Z"));
  expect(dateInterval("2026-10-04T12:00:00-07:00").start).toBe(Date.parse("2026-10-04T19:00:00Z"));
});

it("late imports distinguish occurrence, recording, update and due dates before search/list pagination", async () => {
  const f = await fixture();
  await f.put("meeting_old", { type: "meeting", fields: { occurred_at: "2020-05-10" } });
  await f.put("event_old", event("2020-05-10", { dependencies: ["meeting_old"] }));
  await f.put("task_due", {
    ...event("2020-05-10"),
    claim_kind: "commitment",
    due_at: "2026-10-05",
  });
  await f.put(
    "undated_note",
    {},
    "private",
    "Launch review\n## Timeline\n- **2020-05-10** | Markdown-only date",
  );
  const old = await f.service.timeline({ since: "2020-05-10", until: "2020-05-10" }, f.owner);
  expect(Check(contract.operations.timeline.output, old)).toBeTruthy();
  expect(ids(old).toSorted(defaultOrder)).toStrictEqual(["event_old", "meeting_old", "task_due"]);
  expect(
    old.items.every((row) => row.date === "2020-05-10" && row.precision === "day"),
  ).toBeTruthy();
  expect((await f.service.timeline({ since: "2026-10-04" }, f.owner)).total).toBe(0);
  expect(
    (await f.service.timeline({ timeField: "recorded_at", since: "2026-10-04" }, f.owner)).total,
  ).toBe(4);
  expect(
    ids(
      await f.service.timeline(
        { timeField: "due_at", since: "2026-10-05", until: "2026-10-05" },
        f.owner,
      ),
    ),
  ).toStrictEqual(["task_due"]);
  const search = await f.service.grep(
    { query: "launch", since: "2020-05-10", until: "2020-05-10", limit: 1 },
    f.owner,
  );
  expect(search.total).toBe(3);
  expect(search.hits.length).toBe(1);
  expect(
    (await f.service.records({ timeField: "recorded_at", since: "2026-10-04" }, f.owner)).total,
  ).toBe(4);
  expect(
    (await f.service.records({ timeField: "due_at", until: "2026-10-05" }, f.owner)).total,
  ).toBe(1);
  await expect(f.service.grep({ query: "launch", since: "nonsense" }, f.owner)).rejects.toThrow();
  await expect(f.service.records({ since: "2026-02-30" }, f.owner)).rejects.toThrow();
});

it("day/week queries honor IANA zones and retain literal date-only dates", async () => {
  const f = await fixture();
  await f.put("event_instant", event("2026-10-04T01:30:00Z"));
  await f.put("event_calendar", event("2026-10-04"));
  await f.put("event_monday", event("2026-09-28"));
  const west = await f.service.chronicle_day(
    { date: "2026-10-03", timezone: "America/Los_Angeles" },
    f.owner,
  );
  expect(ids(west)).toStrictEqual(["event_instant"]);
  expect(
    ids(
      await f.service.chronicle_day(
        { date: "2026-10-04", timezone: "America/Los_Angeles" },
        f.owner,
      ),
    ),
  ).toStrictEqual(["event_calendar"]);
  const week = await f.service.chronicle_day({ date: "2026-10-04", week: true }, f.owner);
  expect(week.total).toBe(3);
  expect(Check(contract.operations.chronicle_day.output, week)).toBeTruthy();
  await expect(f.service.chronicle_day({ date: "2026-02-30" }, f.owner)).rejects.toThrow();
  await expect(
    f.service.chronicle_day({ date: "2026-10-04", timezone: "Not/AZone" }, f.owner),
  ).rejects.toThrow();
});

it("one shared source-event claim folds its meeting while preserving separate events and entity scope", async () => {
  const f = await fixture();
  await f.put("person_alice", { type: "person" });
  await f.put("person_bobby", { type: "person" });
  await f.put("meeting_shared", { type: "meeting", fields: { occurred_at: "2020-05-10" } });
  await f.put(
    "event_shared",
    event("2020-05-10", {
      entities: ["person_alice", "person_bobby"],
      source_page: "meeting_shared",
      source_event: true,
      dependencies: ["meeting_shared"],
    }),
  );
  await f.put(
    "event_followup",
    event("2020-05-11", {
      entities: ["person_alice"],
      source_page: "meeting_shared",
      dependencies: ["meeting_shared"],
    }),
  );
  const all = await f.service.chronicle_since({ since: "2020-05-01" }, f.owner);
  expect(ids(all)).toStrictEqual(["event_shared", "event_followup"]);
  expect(ids(await f.service.timeline({ entity: "person_bobby" }, f.owner))).toStrictEqual([
    "event_shared",
  ]);
  expect(ids(await f.service.timeline({ kind: "meeting" }, f.owner))).toStrictEqual([
    "meeting_shared",
  ]);
  const last = await f.service.chronicle_last_seen(
    { entity: "person_alice", occurredOnOrBefore: "2020-05-10" },
    f.owner,
  );
  expect(Check(contract.operations.chronicle_last_seen.output, last)).toBeTruthy();
  expect(last.last!.record.id).toBe("event_shared");
  expect((await f.service.chronicle_last_seen({ entity: "missing_entity" }, f.owner)).last).toBe(
    null,
  );
});

it("scope, withdrawn dependencies, fixture exclusion and historical eligibility precede counts", async () => {
  const f = await fixture(),
    sessionId = randomUUID(),
    partition = "conversations/" + sessionId;
  await f.put("event_private", event("2020-05-10"));
  await f.put("event_shared", event("2020-05-10"), partition);
  await f.put("event_fixture", event("2020-05-10", { record_class: "fixture" }), partition);
  await f.put("event_superseded", event("2020-05-10", { lifecycle: "superseded" }), partition);
  await f.put(
    "event_expired",
    event("2020-05-10", { expires_at: "2020-06-01T00:00:00Z" }),
    partition,
  );
  await f.put("withdrawn_page", { lifecycle: "withdrawn" }, partition);
  await f.put("event_hidden", event("2020-05-10", { dependencies: ["withdrawn_page"] }), partition);
  const group = toolContext(f.api, "main", {
    kind: "conversation",
    agentId: "main",
    sessionKey: "agent:main:group",
    sessionId,
  });
  await f.service.timeline({}, f.owner);
  const result = await f.service.timeline({}, group);
  expect(ids(result)).toStrictEqual(["event_shared"]);
  expect(JSON.stringify(result)).not.toMatch(/event_private|event_hidden|event_fixture/);
  expect((await f.service.timeline({ eligibility: "include_inactive" }, group)).total).toBe(3);
  expect(
    (await f.service.timeline({ entity: "withdrawn_page", eligibility: "include_inactive" }, group))
      .total,
  ).toBe(0);
});

it("pagination detects edits and external changes reconcile", async () => {
  const f = await fixture();
  await f.put("event_first", event("2020-01-01"));
  const second = await f.put("event_second", event("2020-01-02"));
  const page = await f.service.timeline({ order: "asc", limit: 1 }, f.owner);
  expect(page.nextOffset).toBe(1);
  expect(
    ids(
      await f.service.timeline(
        { order: "asc", offset: page.nextOffset!, snapshot: page.snapshot, limit: 1 },
        f.owner,
      ),
    ),
  ).toStrictEqual(["event_second"]);
  const raw = await readFile(second, "utf8");
  await writeFile(second, raw.replace("2020-01-02", "2019-01-02"));
  await expect(f.service.timeline({ offset: 1, snapshot: page.snapshot }, f.owner)).rejects.toThrow(
    /changed/,
  );
  const revised = await f.service.timeline({ order: "asc" }, f.owner);
  expect(ids(revised)).toStrictEqual(["event_second", "event_first"]);
  await rm(second);
  expect((await f.service.timeline({}, f.owner)).total).toBe(1);
});

it("normal publication is visible without a watcher and UI/tool contracts agree", async () => {
  const f = await fixture();
  const receipt = await f.service.save_page(
    {
      requestId: randomUUID(),
      title: "Historical launch review",
      body: "Historical meeting notes",
      type: "meeting",
      fields: { occurred_at: "2020-05-10" },
    },
    f.owner,
  );
  const a = await f.service.chronicle_day({ date: "2020-05-10" }, f.owner);
  const b = await f.service.chronicle_day({ date: "2020-05-10" }, f.operator);
  expect(ids(a)).toStrictEqual([receipt.id]);
  expect(ids(a)).toStrictEqual(ids(b));
  expect(a.snapshot).toBe(b.snapshot);
  expect(Check(contract.operations.chronicle_day.output, a)).toBeTruthy();
});

it("partial projection recovery rebuilds every scope, not just the first reader", async () => {
  const f = await fixture(),
    sessionId = randomUUID();
  await f.put("person_private", { type: "person" });
  await f.put("event_private", event("2020-01-01", { entities: ["person_private"] }));
  await f.put("person_shared", { type: "person" }, "conversations/" + sessionId);
  await f.put(
    "event_shared",
    event("2020-01-01", { entities: ["person_shared"] }),
    "conversations/" + sessionId,
  );
  const group = toolContext(f.api, "main", {
    kind: "conversation",
    agentId: "main",
    sessionKey: "agent:main:group",
    sessionId,
  });
  expect((await f.service.timeline({ entity: "person_private" }, f.owner)).total).toBe(1);
  expect((await f.service.timeline({ entity: "person_shared" }, group)).total).toBe(1);
  const db = new DatabaseSync(f.config.statePath);
  afterTest(() => db.close());
  for (const table of ["temporal_dates_v1", "temporal_entities_v1"]) {
    db.exec("DROP TABLE " + table);
    expect((await f.service.timeline({ entity: "person_private" }, f.owner)).total).toBe(1);
    expect((await f.service.timeline({ entity: "person_shared" }, group)).total).toBe(1);
  }
});

it("high precision storage dates remain queryable and equivalent source instants fold", async () => {
  const f = await fixture();
  await f.put("note_precise", {
    recorded_at: "2026-10-04T12:00:00.123456Z",
    updated_at: "2026-10-04T12:00:00.123456Z",
  });
  for (const timeField of ["recorded_at", "updated_at"] as const) {
    expect((await f.service.timeline({ timeField, since: "2026-10-04" }, f.owner)).total).toBe(1);
    expect((await f.service.records({ timeField, since: "2026-10-04" }, f.owner)).total).toBe(1);
    expect(
      (await f.service.grep({ query: "launch", timeField, since: "2026-10-04" }, f.owner)).total,
    ).toBe(1);
  }
  await f.put("meeting_offset", {
    type: "meeting",
    fields: { occurred_at: "2020-01-01T12:00:00Z" },
  });
  await f.put(
    "event_offset",
    event("2020-01-01T05:00:00-07:00", {
      source_page: "meeting_offset",
      source_event: true,
      dependencies: ["meeting_offset"],
    }),
  );
  expect(ids(await f.service.timeline({}, f.owner))).toStrictEqual(["event_offset"]);
  const sessionId = randomUUID(),
    sessionKey = "agent:main:chronicle-test";
  const caller = {
    ...f.owner,
    toolCallId: randomUUID(),
    tool: { ...f.owner.tool, sessionId, sessionKey },
  };
  const last = await f.service.chronicle_last_seen({ entity: "meeting_offset" }, caller);
  const activity = await f.service.session_activity({ sessionId, sessionKey }, f.operator);
  expect(activity.items[0]!.operation).toBe("chronicleLastSeen");
  expect(activity.items[0]!.id).toBe("event_offset");
  expect(returnedRecords(last)).toStrictEqual([
    { id: "event_offset", revision: last.last!.record.revision },
  ]);
});

it("unprovisioned operator temporal reads stay empty without creating storage", async () => {
  const base = tempDirs.make("knowledge-chronicle-empty-");

  const f = hostApi(base, { policy: { operatorRead: true } }),
    service = createKnowledgeService(f.api),
    operator = operatorContext(f.api, ["operator.read"]);
  for (const [op, input] of [
    ["timeline", {}],
    ["chronicle_day", { date: "2026-10-04" }],
    ["chronicle_since", { since: "2026-10-04" }],
    ["chronicle_last_seen", { entity: "person_missing" }],
  ] as ["timeline" | "chronicle_day" | "chronicle_since" | "chronicle_last_seen", any][]) {
    const result: { last?: unknown; total?: unknown } = await service[op](input, operator);
    expect(Check(contract.operations[op].output, result)).toBeTruthy();
    expect(op === "chronicle_last_seen" ? result.last : result.total).toBe(
      op === "chronicle_last_seen" ? null : 0,
    );
  }
  expect((await service.status({}, operator)).store).toBe("unprovisioned");
  await expect(
    service.chronicle_day({ date: "2026-10-04", timezone: "Not/AZone" }, operator),
  ).rejects.toThrow();
  await expect(service.timeline({ since: "2026-02-30" }, operator)).rejects.toThrow();
  // Deliberately omits the required `since`.
  await expect(service.chronicle_since({} as SinceInput, operator)).rejects.toThrow();
});

it("source summaries are page-local, deduplicated, snapshot fenced and lifecycle aware", async () => {
  const f = await fixture();
  await f.put("person_alice", { type: "person" });
  await f.put("meeting_shared", {
    type: "meeting",
    title: "Shared source",
    fields: { occurred_at: "2020-05-10" },
  });
  await f.put(
    "event_current",
    event("2020-05-10", { entities: ["person_alice"], source_page: "meeting_shared" }),
  );
  await f.put(
    "event_previous",
    event("2020-05-09", {
      lifecycle: "superseded",
      superseded_by: "event_current",
      entities: ["person_alice"],
      source_page: "meeting_shared",
    }),
  );
  const input: TimelineInput = {
    entity: "person_alice",
    includeSources: true,
    eligibility: "include_inactive",
    limit: 1,
  };
  const first = await f.service.timeline(input, f.owner);
  expect(first.sources!.length).toBe(1);
  expect(first.sources![0]!.title).toBe("Shared source");
  expect(first.items[0]!.record.lifecycle).toBe("active");
  expect(Check(contract.operations.timeline.output, first)).toBeTruthy();
  const second = await f.service.timeline(
    { ...input, offset: first.nextOffset!, snapshot: first.snapshot },
    f.owner,
  );
  expect(second.items[0]!.record.lifecycle).toBe("superseded");
  expect(second.items[0]!.record.supersededBy).toBe("event_current");
  expect(second.sources!.length).toBe(1);
  expect(second.nextOffset).toBe(null);
  await expect(
    f.service.timeline({ ...input, includeSources: false, snapshot: first.snapshot }, f.owner),
  ).rejects.toThrow(/restart/);
  const both = await f.service.timeline({ ...input, limit: 100 }, f.owner);
  expect(both.sources!.length).toBe(1);
  expect((await f.service.timeline({ entity: "person_alice" }, f.owner)).sources).toBe(undefined);
  const last = await f.service.chronicle_last_seen(
    {
      entity: "person_alice",
      occurredOnOrBefore: "2020-05-09",
      eligibility: "include_inactive",
      includeSources: true,
    },
    f.owner,
  );
  expect(last.last!.record.id).toBe("event_previous");
  expect(last.sources![0]!.id).toBe("meeting_shared");
  expect(last.selection).toStrictEqual({
    timeField: "occurred_at",
    onOrBefore: "2020-05-09",
    eligibility: "include_inactive",
  });
  expect(Check(contract.operations.chronicle_last_seen.output, last)).toBeTruthy();
});

it("temporal source summaries fit the full response budget and never skip rows", async () => {
  const f = await fixture();
  for (let i = 0; i < 35; i++) {
    const n = String(i).padStart(3, "0");
    await f.put("meeting_" + n, {
      type: "meeting",
      title: "🌱".repeat(90),
      fields: { occurred_at: "2020-05-10" },
    });
    await f.put(
      "event_" + n,
      event("2020-05-10", { source_page: "meeting_" + n, source_event: true }),
      "private",
      "🌱".repeat(499) + "x😀",
    );
  }
  const input = { includeSources: true, limit: 100 };
  let page = await f.service.timeline(input, f.owner);
  const all = [];
  expect(page.nextOffset !== null).toBeTruthy();
  for (;;) {
    expect(Buffer.byteLength(JSON.stringify(page)) <= 24 * 1024).toBeTruthy();
    expect(page.items.every((row) => row.summary.isWellFormed())).toBeTruthy();
    expect(page.sources!.length).toBe(page.items.length);
    expect(page.sources!.every((s) => page.items.some((i) => i.sourcePage === s.id))).toBeTruthy();
    all.push(...ids(page));
    if (page.nextOffset === null) {
      break;
    }
    page = await f.service.timeline(
      { ...input, offset: page.nextOffset, snapshot: page.snapshot },
      f.owner,
    );
  }
  expect([all.length, new Set(all).size]).toStrictEqual([35, 35]);
});
