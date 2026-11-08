import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { writeFile, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import { SqliteIdentityStore } from "./identity-store.js";
import type { BatchInput } from "./ingestion-contract.js";
import { createKnowledgeService } from "./service.js";
import { KnowledgeStorage } from "./storage.js";
import { draft, edit } from "./structured-write.test-support.js";
import {
  accessFor,
  apiFor,
  createVault,
  operatorContext,
  toolContext,
  useTestTempDirs,
} from "./test-support.js";

const tempDirs = useTestTempDirs();

// Guard fields that fence an edit, withdrawal or verification to one observed revision.
const guard = (r: any) => ({ id: r.id, expectedRevision: r.revision, expectedHash: r.hash });

async function batchFixture() {
  const base = tempDirs.make("knowledge-write-");
  const { root, config } = await createVault(base);
  const api = apiFor(base, config);
  const owner = toolContext(api);
  const f = {
    root,
    config,
    api,
    owner,
    operator: operatorContext(api),
    store: new SqliteIdentityStore(config.statePath),
    service: createKnowledgeService(api),
    access: () => accessFor(owner, true),
  };
  const original = await f.service.attach(
    {
      requestId: randomUUID(),
      filename: "meeting.txt",
      attribution: "Recorder export",
      offset: 0,
      data: Buffer.from(
        "Morgan attended the review.\nMorgan will send the report on Friday.",
      ).toString("base64"),
      final: true,
    },
    f.owner,
  );
  const fingerprint = (await f.service.ontology({}, f.owner)).fingerprint;
  const input = {
    requestId: randomUUID(),
    expectedVaultId: f.config.vaultId,
    expectedOntologyFingerprint: fingerprint,
    source: { provider: "trial", key: "meeting-1", sha256: original.evidence!.sha256 },
    items: [
      {
        key: "meeting",
        kind: "page",
        input: {
          title: "Review",
          type: "meeting",
          body: "Review with [[@morgan|Morgan]]. See [[@meeting|source]].",
          attachments: [original.evidence!],
        },
      },
      {
        key: "morgan",
        kind: "page",
        input: { title: "Morgan", type: "person", body: "Attended [[@meeting|Review]]." },
      },
      {
        key: "action",
        kind: "claim",
        input: {
          title: "Send report",
          body: "Morgan offered to send the report Friday.",
          claim_kind: "commitment",
          assertion_origin: "source",
          attribution: "Morgan, recorder line 2",
          evidence: [{ ...original.evidence!, start_line: 2, end_line: 2 }],
          owner: "@morgan",
          source_page: "@meeting",
          dependencies: ["@meeting"],
          entities: ["@morgan"],
        },
      },
      {
        key: "attendance",
        kind: "relationship",
        input: {
          title: "Attended review",
          body: "Morgan attended.",
          from: "@morgan",
          to: "@meeting",
          label: "attended",
          attribution: "Recorder line 1",
          evidence: [{ ...original.evidence!, start_line: 1, end_line: 1 }],
        },
      },
    ],
  } satisfies BatchInput;
  expect(Check(contract.operations.publish_batch.input, input)).toBeTruthy();
  return { ...f, input, original };
}
const verifyInput = (receipt: any) => ({ records: receipt.items.map(guard) });

it("one batch resolves forward references, self-links, claims/edges; one bounded verification checks all outputs", async () => {
  const f = await batchFixture(),
    receipt = await f.service.publish_batch(f.input, f.owner);
  expect(Check(contract.operations.publish_batch.output, receipt)).toBeTruthy();
  expect(receipt.state).toBe("published");
  expect(receipt.items!.length).toBe(4);
  const ids: Record<string, any> = Object.fromEntries(receipt.items!.map((r) => [r.key, r.id]));
  const action = (await f.service.record({ id: ids.action, includeMetadata: true }, f.owner))
    .record;
  expect(action!.metadata!.owner).toBe(ids.morgan);
  expect(action!.metadata!.source_page).toBe(ids.meeting);
  const meeting = await f.service.record({ id: ids.meeting }, f.owner);
  expect(meeting.record!.body).toMatch(new RegExp(ids.morgan));
  expect(meeting.links!.every((l) => l.status === "resolved")).toBeTruthy();
  expect((await f.service.history({}, f.owner)).mutations.length).toBe(1);
  expect(JSON.parse(await readFile(path.join(f.root, "vault.json"), "utf8")).generation).toBe(1);
  const verified = await f.service.verify(verifyInput(receipt), f.owner);
  expect(Check(contract.operations.verify.output, verified)).toBeTruthy();
  expect(verified.passed).toBe(4);
  expect(verified.failed).toBe(0);
  expect(verified.index).toBe("ready");
  expect(Buffer.byteLength(JSON.stringify(verified)) < 1200).toBeTruthy();
  expect(await createKnowledgeService(f.api).publish_batch(f.input, f.owner)).toStrictEqual(
    receipt,
  );
  await expect(
    f.service.publish_batch({ ...f.input, items: f.input.items.slice(0, 2) }, f.owner),
  ).rejects.toThrow(/different payload/);
  const recovery = await f.service.mutation(
    { requestId: receipt.requestId, includeFiles: false },
    f.owner,
  );
  expect(Check(contract.operations.mutation.output, recovery)).toBeTruthy();
  expect(recovery.files.length).toBe(0);
  expect(recovery.totalFiles).toBe(4);
  const first = await f.service.mutation({ requestId: receipt.requestId }, f.owner);
  expect(first.files.length).toBe(3);
  expect(first.nextOffset).toBe(3);
  const last = await f.service.mutation(
    { requestId: receipt.requestId, offset: first.nextOffset! },
    f.owner,
  );
  expect(last.files.length).toBe(1);
  expect(last.nextOffset).toBe(null);
  await expect(
    f.service.publish_batch({ ...f.input, requestId: randomUUID() }, f.operator),
  ).rejects.toThrow(/chat and agent/);
});

for (const stage of [
  "after-accept",
  "after-install:private/people/",
  "after-install:private/claims/",
  "before-receipt",
]) {
  it(`batch interruption ${stage} resumes once with no partial reads`, async () => {
    const f = await batchFixture(),
      storage = new KnowledgeStorage(f.config, f.store, (where) => {
        if (where.startsWith(stage)) {
          throw new Error("simulated interruption");
        }
      });
    await expect(storage.batch(f.input, f.access(), "agent")).rejects.toThrow(
      /simulated interruption/,
    );
    await expect(f.service.records({}, f.owner)).rejects.toThrow(/publication|identity/);
    const status = await f.service.source_check(f.input.source, f.owner);
    expect(status.state).toBe("unchanged");
    expect(status.receipt!.state).toBe("accepted");
    const receipt = await createKnowledgeService(f.api).publish_batch(f.input, f.owner);
    expect(receipt.state).toBe("published");
    expect((await f.service.records({}, f.owner)).total).toBe(4);
    expect(await f.service.resume({ requestId: f.input.requestId }, f.owner)).toStrictEqual(
      receipt,
    );
  });
}

it("prevalidation rejects a late invalid item without accepting any records", async () => {
  const f = await batchFixture();
  const bad = structuredClone(f.input);
  bad.items[3]!.input.label = "not_declared";
  await expect(f.service.publish_batch(bad, f.owner)).rejects.toThrow(/valid type/);
  expect((await f.service.records({}, f.owner)).total).toBe(0);
  expect(
    (await f.service.mutation({ requestId: bad.requestId, includeFiles: false }, f.owner)).receipt,
  ).toBe(null);
  bad.items[3]!.input.label = "attended";
  bad.items[2]!.input.owner = "@unknown";
  await expect(f.service.publish_batch(bad, f.owner)).rejects.toThrow(/Unknown local/);
  bad.items[2]!.input.owner = "@morgan";
  bad.items[3]!.input.from = "@action";
  await expect(f.service.publish_batch(bad, f.owner)).rejects.toThrow(/invalid-reference/);
  bad.items[3]!.input.from = "@morgan";
  bad.source.sha256 = "a".repeat(64);
  await expect(f.service.publish_batch(bad, f.owner)).rejects.toThrow(/hash must match/);
  expect((await f.service.records({}, f.owner)).total).toBe(0);
});

it("source ID/hash receipts survive replacement; changed bytes require reconciliation, unchanged never republish", async () => {
  const f = await batchFixture();
  expect((await f.service.source_check(f.input.source, f.owner)).state).toBe("missing");
  const first = await f.service.publish_batch(f.input, f.owner);
  const service = createKnowledgeService(f.api);
  const checked = await service.source_check(f.input.source, f.owner);
  expect(Check(contract.operations.source_check.output, checked)).toBeTruthy();
  expect(checked.state).toBe("unchanged");
  expect(checked.receipt).toStrictEqual(first);
  expect(
    await service.publish_batch({ ...f.input, requestId: randomUUID() }, f.owner),
  ).toStrictEqual(first);
  const revised = await service.attach(
    {
      requestId: randomUUID(),
      filename: "revised.txt",
      attribution: "Revised export",
      offset: 0,
      data: Buffer.from("Updated original").toString("base64"),
      final: true,
    },
    f.owner,
  );
  const source = { ...f.input.source, sha256: revised.evidence!.sha256 };
  expect((await service.source_check(source, f.owner)).state).toBe("changed");
  const meeting = first.items!.find((i) => i.key === "meeting");
  const input: BatchInput = {
    ...f.input,
    requestId: randomUUID(),
    source,
    items: [
      {
        key: "meeting",
        kind: "page",
        input: {
          ...guard(meeting),
          title: "Review",
          body: "Reconciled revised source",
          attachments: [revised.evidence!],
        },
      },
    ],
  };
  await expect(service.publish_batch(input, f.owner)).rejects.toThrow(/Source changed/);
  const second = await service.publish_batch(
    { ...input, expectedPreviousRequestId: first.requestId },
    f.owner,
  );
  expect(second.items![0]!.id).toBe(meeting!.id);
  expect(second.items![0]!.revision).toBe(2);
  expect((await service.records({}, f.owner)).total).toBe(4);
  // An earlier export returning does not silently return a receipt from the wrong version.
  expect((await service.source_check(f.input.source, f.owner)).state).toBe("changed");
  await service.withdraw(
    { requestId: randomUUID(), ...guard(second.items![0]), reason: "Explicit test withdrawal" },
    f.owner,
  );
  expect(await service.publish_batch({ ...input, requestId: randomUUID() }, f.owner)).toStrictEqual(
    second,
  );
  expect(
    (await service.verify(verifyInput(second), f.owner)).failed,
    "Unchanged original does not resurrect withdrawn outputs",
  ).toBe(1);
});

it("verification catches evidence damage, broken links, changed revisions and explicit absent owner/date expectations", async () => {
  const f = await batchFixture(),
    receipt = await f.service.publish_batch(f.input, f.owner);
  const input = verifyInput(receipt),
    action = receipt.items!.find((i) => i.key === "action"),
    person = receipt.items!.find((i) => i.key === "morgan");
  const exp = input.records.find((r: any) => r.id === action!.id);
  exp.owner = null;
  exp.due_at = "2026-09-25";
  const mismatch = await f.service.verify({ ...input, limit: 1 }, f.owner);
  expect(mismatch.failed).toBe(1);
  expect(mismatch.totalProblems).toBe(2);
  expect(mismatch.nextOffset).toBe(1);
  const next = await f.service.verify(
    { ...input, limit: 1, offset: 1, snapshot: mismatch.snapshot },
    f.owner,
  );
  expect(next.problems[0]!.code).toBe("due_at-mismatch");
  await f.service.save_page(
    edit({ ...person, title: "Morgan" }, { body: "Broken [[unavailable-target]]." }),
    f.owner,
  );
  await expect(
    f.service.verify({ ...input, offset: 1, snapshot: mismatch.snapshot }, f.owner),
  ).rejects.toThrow(/snapshot changed/);
  const changed = await f.service.verify(input, f.owner);
  expect(changed.problems.some((p) => p.code === "missing-link")).toBeTruthy();
  expect(changed.problems.some((p) => p.code === "hash-mismatch")).toBeTruthy();
  await writeFile(path.join(f.root, "private", f.original.evidence!.path), "Tampered original");
  const invalid = await f.service.verify(input, f.owner);
  expect(invalid.problems.some((p) => p.code === "invalid-evidence")).toBeTruthy();
  const missing = await f.service.verify({ records: [{ id: randomUUID() }] }, f.owner);
  expect(missing.failed).toBe(1);
  expect(missing.problems[0]!.code).toBe("unavailable");
});

it("expected graph checks authored links in both directions, subset associations and exact endpoints", async () => {
  const f = await batchFixture(),
    receipt = await f.service.publish_batch(f.input, f.owner);
  const ids: Record<string, any> = Object.fromEntries(receipt.items!.map((r) => [r.key, r.id]));
  const records: any[] = [
    {
      id: ids.meeting,
      expectedLinks: [{ id: ids.morgan, href: "#wiki=" + ids.morgan }, { id: ids.meeting }],
    },
    { id: ids.morgan, expectedLinks: [{ id: ids.meeting }] },
    {
      id: ids.action,
      expectedEntities: [ids.morgan],
      expectedDependencies: [ids.meeting],
      source_page: ids.meeting,
      from: null,
    },
    { id: ids.attendance, from: ids.morgan, to: ids.meeting, label: "attended", source_page: null },
  ];
  expect(Check(contract.operations.verify.input, { records })).toBeTruthy();
  const result = await f.service.verify({ records }, f.owner);
  expect(result.passed).toBe(4);
  expect(result.totalProblems).toBe(0);
  expect(Buffer.byteLength(JSON.stringify(result)) < 1200).toBeTruthy();
  const wrong = await f.service.verify(
    {
      records: [
        {
          id: ids.meeting,
          expectedLinks: [{ id: ids.meeting, href: "#wiki=" + ids.morgan }, { id: randomUUID() }],
        },
        {
          id: ids.action,
          expectedEntities: [ids.meeting],
          expectedDependencies: [ids.morgan],
          source_page: null,
        },
        { id: ids.attendance, from: ids.meeting, to: ids.morgan, label: "knows" },
      ],
      limit: 50,
    },
    f.owner,
  );
  expect(wrong.failed).toBe(3);
  expect(new Set(wrong.problems.map((p) => p.code))).toStrictEqual(
    new Set([
      "expected-link-mismatch",
      "missing-expected-link",
      "missing-expected-entities",
      "missing-expected-dependencies",
      "source_page-mismatch",
      "from-mismatch",
      "to-mismatch",
      "label-mismatch",
    ]),
  );
  await expect(
    f.service.verify(
      { records: [{ ...records[0], expectedLinks: [] }], snapshot: result.snapshot },
      f.owner,
    ),
  ).rejects.toThrow(/snapshot changed/);
  expect(
    (
      await f.service.verify(
        { records: [{ id: ids.action, expectedEntities: [], expectedDependencies: [] }] },
        f.owner,
      )
    ).passed,
    "Subset expectations permit extra associations",
  ).toBe(1);
  const person = (await f.service.record({ id: ids.morgan }, f.owner)).record;
  await f.service.save_page(
    edit(person, { body: "Morgan profile without authored meeting link." }),
    f.owner,
  );
  const reverse = await f.service.verify({ records: records.slice(0, 2) }, f.owner);
  expect(reverse.passed).toBe(1);
  expect(reverse.failed).toBe(1);
  expect(
    reverse.problems.map((p) => [p.id, p.code]),
    "Derived backlink cannot satisfy an authored reverse link",
  ).toStrictEqual([[ids.morgan, "missing-expected-link"]]);
});

it("expected link identities stay bound to stable IDs across renames and fail closed for ambiguity", async () => {
  const f = await batchFixture(),
    receipt = await f.service.publish_batch(f.input, f.owner);
  const ids: Record<string, any> = Object.fromEntries(receipt.items!.map((r) => [r.key, r.id]));
  const personPath = path.join(
    f.root,
    "private",
    receipt.items!.find((r) => r.key === "morgan")!.path,
  );
  const input = { records: [{ id: ids.meeting, expectedLinks: [{ id: ids.morgan }] }] };
  const before = await f.service.verify(input, f.owner);
  await rename(personPath, path.join(path.dirname(personPath), "renamed-morgan.md"));
  await expect(f.service.verify({ ...input, snapshot: before.snapshot }, f.owner)).rejects.toThrow(
    /snapshot changed/,
  );
  expect((await f.service.verify(input, f.owner)).passed).toBe(1);
  const meeting = (await f.service.record({ id: ids.meeting }, f.owner)).record;
  await f.service.save_page(edit(meeting, { body: "Review with [[Morgan]]." }), f.owner);
  await f.service.save_page({ ...draft(), title: "Morgan", type: "person" }, f.owner);
  expect((await f.service.verify(input, f.owner)).failed).toBe(1);
});

it("group scope cannot discover private source receipts or verification content", async () => {
  const f = await batchFixture(),
    receipt = await f.service.publish_batch(f.input, f.owner);
  f.owner.tool.memoryAudience = {
    kind: "conversation",
    agentId: "main",
    sessionKey: "agent:main:group",
    sessionId: randomUUID(),
  };
  const source = await f.service.source_check(f.input.source, f.owner);
  expect(source.state).toBe("missing");
  expect(source.receipt).toBe(null);
  const checked = await f.service.verify(
    {
      records: receipt.items!.map((r) => ({
        id: r.id,
        expectedLinks: [{ id: receipt.items![0]!.id }],
        expectedEntities: [receipt.items![0]!.id],
      })),
    },
    f.owner,
  );
  expect(checked.failed).toBe(4);
  expect(checked.problems.every((p) => p.code === "unavailable")).toBeTruthy();
  expect(!JSON.stringify(checked).includes("Morgan")).toBeTruthy();
});

it("batch edits retain external changes on conflict and cannot publish partially", async () => {
  const f = await batchFixture(),
    first = await f.service.publish_batch(f.input, f.owner);
  const person = first.items!.find((i) => i.key === "morgan"),
    meeting = first.items!.find((i) => i.key === "meeting");
  const editBatch: BatchInput = {
    requestId: randomUUID(),
    expectedVaultId: f.config.vaultId,
    expectedOntologyFingerprint: f.input.expectedOntologyFingerprint,
    items: [
      {
        key: "person",
        kind: "page",
        input: { ...guard(person), title: "Morgan", body: "Profile" },
      },
      {
        key: "meeting",
        kind: "page",
        input: { ...guard(meeting), title: "Review", body: "Review" },
      },
    ],
  };
  const filename = path.join(f.root, "private", person!.path);
  const before = await readFile(filename, "utf8");
  const storage = new KnowledgeStorage(f.config, f.store, (stage) => {
    if (stage === "after-accept") {
      writeFileSync(filename, before.replace("Attended", "External authored change: attended"));
    }
  });
  const receipt = await storage.batch(editBatch, f.access(), "agent");
  expect(receipt.state).toBe("conflict");
  expect(await readFile(filename, "utf8")).toMatch(/External authored change/);
  await expect(f.service.records({}, f.owner)).rejects.toThrow(/publication/);
  expect((await f.service.resume({ requestId: editBatch.requestId }, f.owner)).state).toBe(
    "conflict",
  );
});

it("evidence changed before acceptance rejects the entire batch", async () => {
  const f = await batchFixture();
  const storage = new KnowledgeStorage(f.config, f.store, (stage) => {
    if (stage === "before-accept") {
      writeFileSync(path.join(f.root, "private", f.original.evidence!.path), "Changed evidence");
    }
  });
  await expect(storage.batch(f.input, f.access(), "agent")).rejects.toThrow();
  expect((await f.service.history({}, f.owner)).mutations.length).toBe(0);
  expect((await f.service.records({}, f.owner)).total).toBe(0);
});

it("verification reports unavailable index instead of a false pass", async () => {
  const f = await batchFixture(),
    receipt = await f.service.publish_batch(f.input, f.owner);
  // A malformed projection is not authoritative data; verification must report failure.
  f.store.withDatabase((db) =>
    db.exec("DROP TABLE keyword_state_v1; CREATE TABLE keyword_state_v1 (wrong TEXT)"),
  );
  const checked = await f.service.verify(verifyInput(receipt), f.owner);
  expect(checked.index).toBe("unavailable");
  expect(checked.failed).toBe(4);
  expect(checked.problems.every((p) => p.code === "index-unavailable")).toBeTruthy();
});
