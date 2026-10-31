import { randomUUID } from "node:crypto";
import { writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import { SqliteIdentityStore } from "./identity-store.js";
import { createKnowledgeService } from "./service.js";
import { KnowledgeStorage } from "./storage.js";
import { draft, edit, seedStructuredWriteFixture } from "./structured-write.test-support.js";
import {
  accessFor,
  apiFor,
  createVault,
  defaultOrder,
  operatorContext,
  toolContext,
  useTestTempDirs,
  type TestAudience,
} from "./test-support.js";

const tempDirs = useTestTempDirs();

async function foundation() {
  const base = tempDirs.make("knowledge-write-");
  const { root, config } = await createVault(base);
  const api = apiFor(base, config);
  const owner = toolContext(api);
  const f: any = {
    root,
    config,
    api,
    owner,
    operator: operatorContext(api),
    store: new SqliteIdentityStore(config.statePath),
    service: createKnowledgeService(api),
    access: () => accessFor(owner, true),
    setAudience: (value: TestAudience) => {
      owner.tool.memoryAudience = value;
    },
  };
  await seedStructuredWriteFixture(f);
  return f;
}

const target = (r: any) => ({ id: r.id, expectedRevision: r.revision, expectedHash: r.hash });
const correction = (f: any, r: any, extra = {}) => {
  const { requestId, expectedOntologyFingerprint, ...replacement } = f.claim({
    title: "Corrected option C",
    body: "Alex actually chose option C.",
  });
  return {
    requestId,
    expectedOntologyFingerprint,
    ...target(r),
    reason: "User corrected the mistaken decision",
    replacement: { kind: "claim", ...replacement },
    ...extra,
  };
};
const withdrawal = (r: any) => ({
  requestId: randomUUID(),
  ...target(r),
  reason: "Retracted explicitly by the user",
});
const read = async (f: any, id: string) =>
  (await f.service.record({ id, includeMetadata: true }, f.owner)).record;
const groupAudience = () => ({
  kind: "conversation",
  agentId: "main",
  sessionKey: "agent:main:group",
  sessionId: randomUUID(),
});

it("recent groups exact lifecycle publications before paging, suppresses inactive assertions, and pins new activity", async () => {
  const f = await foundation(),
    original = await f.service.create_claim(f.claim(), f.owner);
  const dependent = await f.service.save_page(
    { ...draft(), title: "Dependent summary", dependencies: [original.id] },
    f.owner,
  );
  const input = correction(f, original),
    corrected = await f.service.correct(input, f.owner);
  await f.service.correct(input, f.owner);
  const withdrawn = await f.service.withdraw(withdrawal(corrected), f.owner);
  const all = await f.service.recent({ limit: 50 }, f.owner);
  expect(Check(contract.operations.recent.output, all)).toBeTruthy();
  // A withdrawal names the withdrawn record; a correction names the original.
  expect(all.items.slice(0, 2)).toMatchObject([
    { change: "withdrawn", id: corrected.id, at: withdrawn.at, title: "Corrected option C" },
    { change: "corrected", id: original.id, at: corrected.at, title: "Option B decision" },
  ]);
  expect(all.items[1]!.replacementActive).toBe(false);
  expect(
    all.items.filter((r: any) => r.change === "corrected").length,
    "paired observations and identical retries yield one event",
  ).toBe(1);
  expect(all.items.some((r: any) => r.id === dependent.id)).toBe(false);
  expect(
    JSON.stringify(all).includes("Alex chose option B."),
    "historical bodies stay out of the feed",
  ).toBe(false);
  expect(
    all.items.filter((r: any) => r.title).length,
    "current pages and explicitly labeled lifecycle events have names",
  ).toBe(5);
  const first = await f.service.recent({ limit: 1 }, f.owner);
  await f.service.save_page({ ...draft(), title: "New arrival" }, f.owner);
  const rest = [];
  let cursor = first.nextBefore;
  while (cursor !== null) {
    const page = await f.service.recent(
      { limit: 1, upperSequence: first.upperSequence, beforeSequence: cursor },
      f.owner,
    );
    rest.push(...page.items);
    cursor = page.nextBefore;
  }
  expect(
    [first.items[0], ...rest],
    "keyset paging cannot split a correction or shift after a new save",
  ).toStrictEqual(all.items);
  expect((await f.service.recent({}, f.operator)).items[0]!.title).toBe("New arrival");
  f.setAudience(groupAudience());
  expect(
    (await f.service.recent({}, f.owner)).items,
    "private activity never appears in conversation scope",
  ).toStrictEqual([]);
});

it("recent distinguishes imports from writes and rechecks dependency eligibility on each page", async () => {
  const f = await foundation(),
    claim = await f.service.create_claim(f.claim(), f.owner);
  const before = await f.service.recent({}, f.owner);
  const record = (await f.service.record({ id: f.pages.person.id, view: "raw" }, f.owner)).record;
  const raw = record!
    .raw!.replace(record!.id, randomUUID())
    .replace("title: person", "title: Imported person");
  await writeFile(path.join(f.root, "private", "people", "imported.md"), raw);
  const imported = await f.service.recent({}, f.owner);
  expect(imported.items[0]!.change).toBe("observed");
  await writeFile(
    path.join(f.root, "private", "people", "imported.md"),
    raw.replace("Imported person", "Edited import"),
  );
  expect((await f.service.recent({}, f.owner)).items[0]!.change).toBe("external");
  await f.service.withdraw(withdrawal(f.pages.project), f.owner);
  const pinned = await f.service.recent({ upperSequence: before.upperSequence }, f.owner);
  expect(
    pinned.items.some((r: any) => r.id === claim.id || r.id === f.pages.project.id),
    "pinning order never pins stale content visibility",
  ).toBe(false);
});

it("correction is one logical batch preserving originals, evidence, provenance, chains and unresolved impact", async () => {
  const f = await foundation(),
    original = await f.service.create_claim(f.claim(), f.owner);
  const dependent = await f.service.save_page(
    { ...draft(), title: "Derived summary", dependencies: [original.id] },
    f.owner,
  );
  const indirect = await f.service.save_page(
    { ...draft(), title: "Second summary", dependencies: [dependent.id] },
    f.owner,
  );
  const before = await read(f, original.id);
  const input = correction(f, original),
    receipt = await f.service.correct(input, f.owner);
  expect(receipt).toMatchObject({
    state: "published",
    operation: "correct",
    targetId: original.id,
    id: receipt.replacementId,
  });
  expect(Check(contract.operations.correct.output, receipt)).toBeTruthy();
  expect(
    receipt.impact!.items.map((r: any) => [r.id, r.direct]).toSorted(defaultOrder),
  ).toStrictEqual(
    [
      [dependent.id, true],
      [indirect.id, false],
    ].toSorted(defaultOrder),
  );
  const old = await read(f, original.id);
  const fresh = await read(f, receipt.id);
  expect(old!.lifecycle).toBe("superseded");
  expect(old!.body).toBe(before!.body);
  expect(old!.metadata!.evidence).toStrictEqual(before!.metadata!.evidence);
  expect(old!.metadata!.superseded_by).toBe(receipt.id);
  expect(fresh!.metadata!.supersedes).toBe(old!.id);
  expect(old!.metadata!.lifecycle_change!.reason).toBe(input.reason);
  expect((await f.service.lookup({ query: old!.id }, f.owner)).total).toBe(0);
  expect((await f.service.lookup({ query: old!.id, lifecycle: "all" }, f.owner)).total).toBe(1);
  expect((await f.service.lookup({ query: dependent.id }, f.owner)).total).toBe(0);
  expect((await f.service.lookup({ query: indirect.id }, f.owner)).total).toBe(0);
  expect((await f.service.records({}, f.owner)).total).toBe(4);
  expect((await f.service.status({}, f.owner)).records).toBe(4);
  expect((await f.service.ontology({ name: "note" }, f.owner)).definitions![0]!.recordCount).toBe(
    0,
  );
  expect((await f.service.records({ lifecycle: "all" }, f.owner)).total).toBe(7);
  expect(await f.service.correct(input, f.owner)).toStrictEqual(receipt);
  expect((await f.service.history({ id: old!.id }, f.owner)).mutations[0]!.requestId).toBe(
    input.requestId,
  );
  const mutation = await f.service.mutation({ requestId: input.requestId }, f.owner);
  expect(Check(contract.operations.mutation.output, mutation)).toBeTruthy();
  expect(mutation.files.length).toBe(2);
  const next = await f.service.correct(correction(f, receipt), f.owner);
  expect((await f.service.lookup({ query: receipt.id }, f.owner)).total).toBe(0);
  expect((await f.service.lookup({ query: next.id }, f.owner)).total).toBe(1);
  expect((await read(f, receipt.id))!.metadata!.superseded_by).toBe(next.id);
  // Restore stale active bytes; durable guards survive recreation of the service and keyword projections.
  await writeFile(
    path.join(f.root, "private", old!.path),
    (
      await f.service.revision(
        { sequence: (await f.service.history({ id: old!.id }, f.owner)).entries.at(-1)!.sequence },
        f.owner,
      )
    ).raw,
  );
  const restored = createKnowledgeService(f.api);
  expect((await restored.lookup({ query: old!.id }, f.owner)).total).toBe(0);
  expect(
    (await restored.record({ id: old!.id, includeMetadata: true }, f.owner)).record!.metadata!
      .superseded_by,
  ).toBe(receipt.id);
});

for (const stage of [
  "after-accept",
  "after-first-record",
  "after-second-record",
  "after-link:vault.json",
  "before-receipt",
]) {
  it(`correction recovery at ${stage} never exposes a half-applied catalog`, async () => {
    const f = await foundation(),
      original = await f.service.create_claim(f.claim(), f.owner),
      input = correction(f, original);
    let written = 0;
    const publisher = new KnowledgeStorage(f.config, f.store, (where) => {
      if (where.startsWith("after-link:private/claims/")) {
        written++;
      }
      if (
        where === stage ||
        (stage === "after-first-record" && written === 1) ||
        (stage === "after-second-record" && written === 2)
      ) {
        throw new Error("crash");
      }
    });
    await expect(publisher.correct(input, f.access(), "agent")).rejects.toThrow(/crash/);
    for (const [method, arg] of [
      ["records", {}],
      ["record", { id: original.id }],
      ["grep", { query: "option" }],
      ["lookup", { query: original.id }],
      ["connections", { id: f.pages.project.id }],
      ["ontology", {}],
      ["status", {}],
      ["recent", {}],
    ] as [string, any][]) {
      await expect(f.service[method](arg, f.owner)).rejects.toThrow(/pending|identity|storage/);
    }
    const recovered = await createKnowledgeService(f.api).correct(input, f.owner);
    expect(recovered.state).toBe("published");
    expect(await f.service.correct(input, f.owner)).toStrictEqual(recovered);
    expect((await f.service.records({ kind: "claim" }, f.owner)).total).toBe(1);
    expect((await f.service.records({ kind: "claim", lifecycle: "all" }, f.owner)).total).toBe(2);
    const history = await f.service.history({ id: original.id }, f.owner);
    expect(history.entries.length).toBe(2);
  });
}

it("withdrawal durably hides pages and transitive dependents, preserves evidence/history and exact retry", async () => {
  const f = await foundation(),
    claim = await f.service.create_claim(f.claim(), f.owner),
    edge = await f.service.create_relationship(f.edge(), f.owner);
  const original = (await f.service.record({ id: f.pages.project.id, view: "raw" }, f.owner))
    .record;
  const input = withdrawal(original),
    receipt = await f.service.withdraw(input, f.owner);
  expect(receipt).toMatchObject({
    operation: "withdraw",
    state: "published",
    impact: { total: 2 },
  });
  expect(Check(contract.operations.withdraw.output, receipt)).toBeTruthy();
  expect(await f.service.withdraw(input, f.owner)).toStrictEqual(receipt);
  for (const id of [original!.id, claim.id, edge.id]) {
    expect((await f.service.lookup({ query: id }, f.owner)).total).toBe(0);
  }
  expect((await f.service.connections({ id: f.pages.meeting.id }, f.owner)).total).toBe(0);
  expect((await f.service.records({}, f.owner)).total).toBe(2);
  await writeFile(path.join(f.root, "private", original!.path), original!.raw);
  f.store.withDatabase((db: any) => {
    for (const row of db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name LIKE 'keyword_fts_v1_%' AND sql LIKE 'CREATE VIRTUAL%' ",
      )
      .all()) {
      db.exec(`DROP TABLE ${row.name}`);
    }
  });
  const restored = createKnowledgeService(f.api);
  expect((await restored.records({}, f.owner)).total).toBe(2);
  expect((await restored.grep({ query: "project", lifecycle: "all" }, f.owner)).total).toBe(0);
  const inspection = await restored.record({ id: original!.id, includeMetadata: true }, f.owner);
  expect(inspection.record!.lifecycle).toBe("withdrawn");
  expect(inspection.record!.metadata!.lifecycle_change!.reason).toBe(input.reason);
  const evidence = await restored.attachment(
    { id: claim.id, path: f.evidence.path, sha256: f.evidence.sha256 },
    f.owner,
  );
  expect(evidence.data).toBeTruthy();
});

it("one relationship correction/withdrawal never affects another edge sharing endpoints", async () => {
  const f = await foundation(),
    one = await f.service.create_relationship(f.edge(), f.owner),
    two = await f.service.create_relationship(f.edge(), f.owner);
  const { requestId, expectedOntologyFingerprint, ...replacement } = f.edge({
    body: "Corrected explicit edge",
  });
  const correctionInput = {
    requestId,
    expectedOntologyFingerprint,
    ...target(one),
    reason: "Fix edge attribution",
    replacement: { kind: "relationship", ...replacement },
  };
  const corrected = await f.service.correct(correctionInput, f.owner);
  expect((await f.service.connections({ id: f.pages.meeting.id }, f.owner)).total).toBe(2);
  await f.service.withdraw(withdrawal(corrected), f.owner);
  expect((await f.service.connections({ id: f.pages.meeting.id }, f.owner)).total).toBe(1);
  expect((await f.service.lookup({ query: two.id }, f.owner)).total).toBe(1);
  expect((await read(f, one.id))!.metadata!.superseded_by).toBe(corrected.id);
});

it("invalid, stale, hidden and wrong-kind corrections fail before receipt; no browser lifecycle writes", async () => {
  const f = await foundation(),
    original = await f.service.create_claim(f.claim(), f.owner),
    input = correction(f, original);
  const dependent = await f.service.save_page({ ...draft(), dependencies: [original.id] }, f.owner);
  for (const change of [
    { expectedHash: "0".repeat(64) },
    { expectedRevision: 2 },
    { reason: " " },
    { id: randomUUID() },
    { replacement: { ...input.replacement, evidence: [] } },
    { replacement: { ...input.replacement, dependencies: [original.id] } },
    { replacement: { ...input.replacement, dependencies: [dependent.id] } },
    { expectedOntologyFingerprint: "0".repeat(64) },
    { ...target(f.pages.project) },
    { replacement: { ...input.replacement, lifecycle: "withdrawn" } },
  ]) {
    const bad = { ...input, ...change, requestId: randomUUID() };
    await expect(f.service.correct(bad, f.owner)).rejects.toThrow();
    expect((await f.service.mutation({ requestId: bad.requestId }, f.owner)).receipt).toBe(null);
  }
  await expect(f.service.correct(input, f.operator)).rejects.toThrow(/chat/);
  await expect(f.service.withdraw(withdrawal(original), f.operator)).rejects.toThrow(/chat/);
  f.setAudience(groupAudience());
  await expect(f.service.correct(input, f.owner)).rejects.toThrow(/unavailable/);
  await expect(f.service.withdraw(withdrawal(original), f.owner)).rejects.toThrow(/unavailable/);
  expect((await f.service.mutation({ requestId: input.requestId }, f.owner)).receipt).toBe(null);
});

it("changed payload replay and concurrent edits preserve conflicts and proposed material", async () => {
  const f = await foundation(),
    original = await f.service.create_claim(f.claim(), f.owner),
    input = correction(f, original);
  const file = path.join(f.root, "private", original.path),
    before = await readFile(file, "utf8");
  const publisher = new KnowledgeStorage(f.config, f.store, (where) => {
    if (where === "after-accept") {
      throw new Error("crash");
    }
  });
  await expect(publisher.correct(input, f.access(), "agent")).rejects.toThrow(/crash/);
  await expect(f.service.correct({ ...input, reason: "changed" }, f.owner)).rejects.toThrow(
    /different payload/,
  );
  await writeFile(file, before + "External author edit.");
  const result = await f.service.correct(input, f.owner);
  expect(result.state).toBe("conflict");
  expect(await readFile(file, "utf8")).toBe(before + "External author edit.");
  expect((await f.service.mutation({ requestId: input.requestId }, f.owner)).files.length).toBe(2);
  await expect(f.service.records({}, f.owner)).rejects.toThrow(/pending|conflicted/);
});

for (const stage of ["after-accept", "after-link:vault.json", "before-receipt"]) {
  it(`withdrawal resumes safely after ${stage}`, async () => {
    const f = await foundation(),
      original = await f.service.create_claim(f.claim(), f.owner),
      input = withdrawal(original);
    const publisher = new KnowledgeStorage(f.config, f.store, (where) => {
      if (where === stage) {
        throw new Error("crash");
      }
    });
    await expect(publisher.withdraw(input, f.access(), "agent")).rejects.toThrow(/crash/);
    const result = await createKnowledgeService(f.api).withdraw(input, f.owner);
    expect(result.state).toBe("published");
    expect(await f.service.withdraw(input, f.owner)).toStrictEqual(result);
    expect((await f.service.lookup({ query: original.id, lifecycle: "all" }, f.owner)).total).toBe(
      0,
    );
  });
}

it("withheld derived pages can be repaired explicitly, without silently redirecting evidence", async () => {
  const f = await foundation(),
    original = await f.service.create_claim(f.claim(), f.owner);
  const dependent = await f.service.save_page({ ...draft(), dependencies: [original.id] }, f.owner);
  const corrected = await f.service.correct(correction(f, original), f.owner);
  expect((await f.service.lookup({ query: dependent.id }, f.owner)).total).toBe(0);
  const record = (await f.service.record({ id: dependent.id }, f.owner)).record;
  const repaired = await f.service.save_page(
    edit(record, { body: "Repaired with inspected correction.", dependencies: [corrected.id] }),
    f.owner,
  );
  expect(repaired.state).toBe("published");
  expect((await f.service.lookup({ query: dependent.id }, f.owner)).total).toBe(1);
});

it("pre-upgrade withdrawal guards apply to records and counts even if only stale active files remain", async () => {
  const f = await foundation(),
    original = await f.service.create_claim(f.claim(), f.owner);
  f.store.withDatabase((db: any) =>
    db
      .prepare("INSERT INTO keyword_withdrawals_v1 VALUES (?,?)")
      .run(`${f.config.vaultId}:private`, original.id),
  );
  expect((await f.service.records({ kind: "claim" }, f.owner)).total).toBe(0);
  expect((await f.service.record({ id: original.id }, f.owner)).record!.lifecycle).toBe(
    "withdrawn",
  );
  await expect(f.service.correct(correction(f, original), f.owner)).rejects.toThrow(/unavailable/);
});

it("withdrawing a superseded original dominates its correction guard without withdrawing replacement", async () => {
  const f = await foundation(),
    original = await f.service.create_claim(f.claim(), f.owner),
    corrected = await f.service.correct(correction(f, original), f.owner);
  const old = await read(f, original.id);
  const withdrawalInput = withdrawal(old);
  const receipt = await f.service.withdraw(withdrawalInput, f.owner);
  expect(receipt.state).toBe("published");
  expect((await f.service.record({ id: old!.id }, f.owner)).record!.lifecycle).toBe("withdrawn");
  expect((await f.service.lookup({ query: corrected.id }, f.owner)).total).toBe(1);
  expect((await f.service.lookup({ query: old!.id, lifecycle: "all" }, f.owner)).total).toBe(0);
});

it("withdrawal remains possible when original evidence goes missing", async () => {
  const f = await foundation(),
    original = await f.service.create_claim(f.claim(), f.owner);
  await rm(path.join(f.root, "private", f.evidence.path));
  const record = await read(f, original.id);
  expect(record!.valid).toBe(false);
  const receipt = await f.service.withdraw(withdrawal(record), f.owner);
  expect(receipt.state).toBe("published");
  const after = await read(f, record!.id);
  expect(after!.lifecycle).toBe("withdrawn");
  expect(after!.metadata!.evidence).toStrictEqual(record!.metadata!.evidence);
});

it("lifecycle mutations preserve authored YAML comments, unknown metadata and original text", async () => {
  const f = await foundation(),
    original = await f.service.create_claim(f.claim(), f.owner);
  const file = path.join(f.root, "private", original.path),
    before = await readFile(file, "utf8");
  await writeFile(
    file,
    before.replace(
      "lifecycle: active",
      'lifecycle: active # authored lifecycle note\ncustom_context: "Keep Ω"',
    ),
  );
  const current = (await f.service.record({ id: original.id }, f.owner)).record;
  await f.service.correct(correction(f, current), f.owner);
  const after = await readFile(file, "utf8");
  expect(after.includes("# authored lifecycle note")).toBeTruthy();
  expect(after.includes('custom_context: "Keep Ω"')).toBeTruthy();
  expect((await f.service.record({ id: original.id }, f.owner)).record!.body).toBe(current!.body);
});

const supersede = async (f: any, by: any, superseded: any[], extra = {}) =>
  f.service.supersede(
    {
      requestId: randomUUID(),
      reason: "The outcome replaces the snapshots.",
      by: target(await read(f, by.id)),
      superseded: await Promise.all(superseded.map(async (r) => target(await read(f, r.id)))),
      ...extra,
    },
    f.owner,
  );

it("supersede retires snapshots by an existing outcome without a copy; only undo restores them", async () => {
  const f = await foundation();
  const [red, green, merged] = [
    await f.service.create_claim(f.claim({ title: "CI red" }), f.owner),
    await f.service.create_claim(f.claim({ title: "CI green" }), f.owner),
    await f.service.create_claim(f.claim({ title: "Merged" }), f.owner),
  ];
  const before = await read(f, red.id),
    file = path.join(f.root, "private", red.path),
    raw = await readFile(file, "utf8");
  const receipt = await supersede(f, merged, [red, green]);
  expect(Check(contract.operations.supersede.output, receipt)).toBeTruthy();
  expect(receipt).toMatchObject({
    operation: "supersede",
    targetId: red.id,
    replacementId: merged.id,
    items: [{ key: "superseded", id: red.id, revision: 2 }, { id: green.id }],
  });
  expect(await read(f, red.id)).toMatchObject({
    lifecycle: "superseded",
    body: before.body,
    metadata: {
      superseded_by: merged.id,
      evidence: before.metadata.evidence,
      attribution: before.metadata.attribution,
      lifecycle_change: { reason: "The outcome replaces the snapshots.", actor: "agent" },
    },
  });
  expect((await read(f, merged.id)).revision, "the outcome is not rewritten").toBe(1);
  expect((await f.service.history({ id: red.id }, f.owner)).entries).toHaveLength(2);
  expect((await f.service.records({ kind: "claim", lifecycle: "all" }, f.owner)).total).toBe(3);
  const claims = async (historical = false) =>
    (
      await f.service.connections(
        { id: f.pages.project.id, direction: "claims", historical },
        f.owner,
      )
    ).total;
  expect([await claims(), await claims(true)]).toStrictEqual([1, 3]);
  await writeFile(file, raw);
  expect((await read(f, red.id)).lifecycle, "durable guards beat a stale active file").toBe(
    "superseded",
  );
  expect((await supersede(f, merged, [red, green], { undo: true })).operation).toBe("unsupersede");
  const back = await read(f, red.id);
  expect([back.lifecycle, back.metadata.superseded_by, await claims()]).toStrictEqual([
    "active",
    undefined,
    3,
  ]);
});

it("supersede rejects self, repeats, cycles, other subjects, pages, stale fences, inactive claims and correction undo", async () => {
  const f = await foundation();
  const make = (extra = {}) => f.service.create_claim(f.claim(extra), f.owner);
  const [a, b, c] = [await make(), await make({ title: "B" }), await make({ title: "C" })];
  const other = await f.service.save_page({ ...draft(), title: "Other", type: "project" }, f.owner);
  const { entities: _unused, ...bare } = f.claim();
  const elsewhere = await make({ entities: [other.id] }),
    unlinked = await f.service.create_claim(bare, f.owner);
  const rejects = (promise: Promise<unknown>, message: RegExp) =>
    expect(promise).rejects.toThrow(message);
  await rejects(supersede(f, a, [a]), /cannot supersede itself/);
  await rejects(supersede(f, a, [b, b]), /listed once/);
  await rejects(supersede(f, a, [elsewhere]), /shares no linked page/);
  await rejects(supersede(f, a, [unlinked]), /shares no linked page/);
  await rejects(supersede(f, f.pages.project, [b]), /not a claim/);
  const stale = { ...target(b), expectedRevision: 9 };
  const staleInput = { requestId: randomUUID(), reason: "x", by: target(a), superseded: [stale] };
  await rejects(f.service.supersede(staleInput, f.owner), /Superseded claim unavailable/);
  await supersede(f, a, [b]);
  await rejects(supersede(f, b, [a]), /not current in this scope/);
  await rejects(supersede(f, c, [b]), /is superseded, not active/);
  await rejects(supersede(f, a, [c], { undo: true }), /is not superseded by/);
  await f.service.withdraw(withdrawal(c), f.owner);
  await rejects(supersede(f, a, [c]), /is withdrawn, not active/);
  const corrected = await f.service.correct(correction(f, await read(f, a.id)), f.owner);
  await rejects(supersede(f, corrected, [a], { undo: true }), /replaced by knowledge_correct/);
});

it("supersede rejects a replacement that depends on a superseded claim, directly or through a dependent", async () => {
  const f = await foundation();
  const red = await f.service.create_claim(f.claim({ title: "CI red" }), f.owner);
  const deps = (id: string) => [f.pages.meeting.id, id];
  const merged = await f.service.create_claim(
    f.claim({ title: "Merged", dependencies: deps(red.id) }),
    f.owner,
  );
  const summary = await f.service.save_page(
    { ...draft(), title: "Run summary", dependencies: [red.id] },
    f.owner,
  );
  const shipped = await f.service.create_claim(
    f.claim({ title: "Shipped", dependencies: deps(summary.id) }),
    f.owner,
  );
  for (const by of [merged, shipped]) {
    await expect(supersede(f, by, [red])).rejects.toThrow(/would hide the replacement/);
    expect((await f.service.lookup({ query: by.id }, f.owner)).total).toBe(1);
  }
  expect((await read(f, red.id)).lifecycle).toBe("active");
});
