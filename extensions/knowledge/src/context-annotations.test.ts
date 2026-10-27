import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import { createKnowledgeService } from "./service.js";
import { operatorContext, storeFixture, toolContext, useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

async function setup() {
  const f: any = await storeFixture(tempDirs.make("knowledge-annotations-"), {
    policy: { writesEnabled: true, operatorRead: true },
  });
  f.owner = toolContext(f.api);
  f.operator = operatorContext(f.api);
  f.service = createKnowledgeService(f.api);
  f.fingerprint = (await f.service.ontology({}, f.owner)).fingerprint;
  f.page = async (title: any, type = "meeting") =>
    f.service.save_page(
      { requestId: randomUUID(), title, type, body: `Source context for ${title}.` },
      f.owner,
    );
  f.source = await f.page("Meeting A");
  const upload = await f.service.attach(
    {
      requestId: randomUUID(),
      filename: "source.txt",
      mediaType: "text/plain",
      attribution: "Synthetic isolated source",
      offset: 0,
      data: Buffer.from("Alex will investigate.\nAlex reaffirms the investigation.").toString(
        "base64",
      ),
      final: true,
    },
    f.owner,
  );
  f.evidence = [{ ...upload.evidence, start_line: 1, end_line: 1 }];
  f.claim = async (extra = {}) =>
    f.service.create_claim(
      {
        requestId: randomUUID(),
        expectedOntologyFingerprint: f.fingerprint,
        title: "Investigate",
        body: "Alex will investigate.",
        claim_kind: "commitment",
        assertion_origin: "source",
        attribution: "Alex, source line 1",
        evidence: f.evidence,
        source_page: f.source.id,
        ...extra,
      },
      f.owner,
    );
  f.annotate = async (id: any, annotations: any, extra = {}) => {
    const r = (
      await f.service.record({ id, includeMetadata: true, includeEvidence: true }, f.owner)
    ).record;
    const input = {
      requestId: randomUUID(),
      id,
      expectedRevision: r!.revision,
      expectedHash: r!.hash,
      reason: "Evidence-backed context update",
      annotations,
      ...extra,
    };
    const result = await f.service.annotate(input, f.owner);
    expect(Check(contract.operations.annotate.output, result)).toBeTruthy();
    return { input, result };
  };
  return f;
}

it("context annotations preserve assertion text/lifecycle, append evidence, and fence retries/conflicts", async () => {
  const f = await setup(),
    original = await f.claim();
  const second = await f.claim({
    body: "Alex reaffirmed the investigation.",
    title: "Reaffirmed investigation",
  });
  const { input, result } = await f.annotate(
    second.id,
    {
      continuity: [
        {
          id: original.id,
          relation: "reaffirms",
          basis: "Explicit reaffirmation in the next source line",
          evidence: f.evidence,
        },
      ],
    },
    { addEvidence: f.evidence },
  );
  const read = await f.service.record(
    { id: second.id, includeMetadata: true, includeEvidence: true },
    f.owner,
  );
  expect(read.record!.body).toBe("Alex reaffirmed the investigation.");
  expect(read.record!.lifecycle).toBe("active");
  expect(read.record!.metadata!.supersedes).toBe(undefined);
  expect(read.record!.metadata!.evidence!.length, "Identical support is not duplicated").toBe(1);
  expect(read.record!.metadata!.continuity![0]!.id).toBe(original.id);
  expect(read.relatedStatements![0]!.incoming).toBe(false);
  const reverse = await f.service.record({ id: original.id, includeEvidence: true }, f.owner);
  expect(reverse.relatedStatements![0]!.record.id).toBe(second.id);
  expect(reverse.relatedStatements![0]!.incoming).toBe(true);
  expect(reverse.relatedStatements![0]!.source!.id).toBe(f.source.id);
  const inventory = await f.service.records({ kind: "claim", query: "reaffirmed" }, f.owner);
  expect(inventory.total).toBe(1);
  expect(inventory.facets!.kinds.commitment).toBe(2);
  expect(inventory.facets!.origins.source).toBe(2);
  expect(
    (await f.service.records({ kind: "claim", assertionOrigin: "agent_inference" }, f.owner)).total,
  ).toBe(0);
  expect(
    (await f.service.annotate(input, f.owner)).revision,
    "Replay retains the accepted mutation",
  ).toBe(result.revision);
  await expect(f.service.annotate({ ...input, requestId: randomUUID() }, f.owner)).rejects.toThrow(
    /conflict/,
  );
  await expect(
    f.service.annotate({ ...input, annotations: { body: "Changed meaning" } }, f.owner),
  ).rejects.toThrow(/Invalid/);
  await expect(f.service.annotate(input, f.operator)).rejects.toThrow(/chat/);
  expect((await f.service.record({ id: original.id }, f.owner)).record!.lifecycle).toBe("active");
});

it("related statement text keeps an astral emoji whole at the cap", async () => {
  const f = await setup();
  const original = await f.claim({ body: `${"x".repeat(3999)}\u{1F600}tail` });
  const second = await f.claim();
  await f.annotate(second.id, {
    continuity: [
      {
        id: original.id,
        relation: "reaffirms",
        basis: "Same source context",
        evidence: f.evidence,
      },
    ],
  });
  const read = await f.service.record({ id: second.id, includeEvidence: true }, f.owner);
  expect(read.relatedStatements![0]!.text).toBe("x".repeat(3999));
});

it("uncertain identity and attribution retain evidence; cross-scope guesses and forged evidence are rejected", async () => {
  const f = await setup(),
    person = await f.page("Alex", "person"),
    candidate = await f.page("Alex Candidate", "person");
  await f.annotate(person.id, {
    identity: {
      status: "partial",
      context: "Source handle only",
      candidates: [
        {
          id: candidate.id,
          basis: "Possible spelling match; not a resolved identity",
          evidence: f.evidence,
        },
      ],
    },
  });
  const claim = await f.claim();
  await f.annotate(claim.id, {
    attribution_confidence: {
      level: "medium",
      basis: "Direct roll call; source track remains uncertain",
      evidence: f.evidence,
    },
  });
  await expect(
    f.annotate(person.id, {
      identity: {
        status: "partial",
        context: "Unknown",
        candidates: [{ id: randomUUID(), basis: "Guessed hidden person", evidence: f.evidence }],
      },
    }),
  ).rejects.toThrow(/reference/);
  await expect(
    f.annotate(claim.id, {
      attribution_confidence: {
        level: "high",
        basis: "Bad evidence",
        evidence: [{ ...f.evidence[0], sha256: "0".repeat(64) }],
      },
    }),
  ).rejects.toThrow(/hash|match/i);
  const read = await f.service.record(
    { id: person.id, includeMetadata: true, includeEvidence: true },
    f.owner,
  );
  expect(read.record!.metadata!.identity!.status).toBe("partial");
  expect(
    (await f.service.records({ type: "person" }, f.owner)).total,
    "Candidates never merge identities",
  ).toBe(2);
});

it("fixture classification consistently removes records from current views without erasing exact/history access", async () => {
  const f = await setup(),
    claim = await f.claim({ title: "Fixture canary" });
  await f.annotate(claim.id, { record_class: "fixture" });
  expect((await f.service.records({ kind: "claim" }, f.owner)).total).toBe(0);
  expect((await f.service.lookup({ query: "Fixture canary" }, f.owner)).total).toBe(0);
  expect((await f.service.grep({ query: "Fixture canary" }, f.owner)).total).toBe(0);
  expect(
    (await f.service.connections({ id: f.source.id }, f.owner)).connections.some(
      (r: any) => r.record.id === claim.id,
    ),
  ).toBe(false);
  expect((await f.service.recent({}, f.owner)).items.some((r: any) => r.id === claim.id)).toBe(
    false,
  );
  expect((await f.service.records({ kind: "claim", lifecycle: "all" }, f.owner)).total).toBe(1);
  const exact = await f.service.record(
    { id: claim.id, includeMetadata: true, includeEvidence: true },
    f.owner,
  );
  expect(exact.record!.body).toBe("Alex will investigate.");
  expect(exact.record!.metadata!.record_class).toBe("fixture");
  expect((await f.service.history({ id: claim.id }, f.owner)).entries.length >= 2).toBeTruthy();
});

it("new records with shared annotation evidence serialize without YAML aliases and remain readable", async () => {
  const f = await setup(),
    person = await f.page("Alex", "person"),
    company = await f.page("Example", "company");
  const confidence = {
    level: "high",
    basis: "Explicit self-introduction",
    evidence: f.evidence,
  };
  const claim = await f.claim({ attribution_confidence: confidence });
  const relationship = await f.service.create_relationship(
    {
      requestId: randomUUID(),
      expectedOntologyFingerprint: f.fingerprint,
      from: person.id,
      to: company.id,
      label: "works_at",
      title: "Alex works at Example",
      body: "Alex reports working at Example.",
      attribution: "Isolated synthetic source",
      evidence: f.evidence,
      attribution_confidence: confidence,
    },
    f.owner,
  );
  const page = await f.service.save_page(
    {
      requestId: randomUUID(),
      type: "person",
      title: "Another person",
      body: "Source-qualified profile.",
      attachments: f.evidence,
      attribution_confidence: confidence,
    },
    f.owner,
  );
  for (const receipt of [claim, relationship, page]) {
    const read = await f.service.record(
      { id: receipt.id, includeMetadata: true, includeEvidence: true },
      f.owner,
    );
    expect(
      read.record,
      "Published serialization must survive an independent vault scan",
    ).toBeTruthy();
    expect(read.record!.valid).toBe(true);
    expect(read.evidence![0]!.verified).toBe(true);
    expect(read.record!.metadata!.evidence).toStrictEqual(
      read.record!.metadata!.attribution_confidence!.evidence,
    );
  }
  const next = await f.claim(),
    third = await f.claim();
  const continuity = [next, third].map((r) => ({
    id: r.id,
    relation: "reaffirms",
    basis: "Same source context",
    evidence: f.evidence,
  }));
  await f.annotate(claim.id, { continuity });
  expect(
    (
      await f.service.record(
        { id: claim.id, includeMetadata: true, includeEvidence: true },
        f.owner,
      )
    ).record!.metadata!.continuity!.length,
  ).toBe(2);
  const saved = (await f.service.record({ id: page.id }, f.owner)).record;
  const candidate = await f.page("Alex candidate", "person");
  const identity = {
    status: "partial",
    context: "Unresolved source name",
    candidates: [person, candidate].map((r) => ({
      id: r.id,
      basis: "Possible name match",
      evidence: f.evidence,
    })),
  };
  await f.service.save_page(
    {
      requestId: randomUUID(),
      id: page.id,
      expectedRevision: saved!.revision,
      expectedHash: saved!.hash,
      title: saved!.title,
      body: saved!.body,
      identity,
    },
    f.owner,
  );
  expect(
    (await f.service.record({ id: page.id, includeMetadata: true, includeEvidence: true }, f.owner))
      .record!.metadata!.identity!.candidates!.length,
  ).toBe(2);
  expect((await f.service.diagnostics({}, f.owner)).total).toBe(0);
});

it("source groups are counted before pagination; repeated saves and new activity do not split a source group", async () => {
  const f = await setup(),
    sourceB = await f.page("Meeting B");
  await f.claim({ source_page: sourceB.id, title: "Other source commitment" });
  for (let i = 0; i < 23; i++) {
    await f.claim({ title: `Meeting A commitment ${i}` });
  }
  const first = await f.service.recent({ groupBySource: true, limit: 1 }, f.owner);
  expect(Check(contract.operations.recent.output, first)).toBeTruthy();
  expect(first.items.length).toBe(1);
  expect(first.items[0]!.group!.source.id).toBe(f.source.id);
  expect(first.items[0]!.group!.counts.commitment).toBe(23);
  expect(first.items[0]!.group!.total, "Source page and twenty-three distinct claims").toBe(24);
  const continuation = await f.service.recent(
    {
      groupBySource: true,
      sourceId: f.source.id,
      recordOffset: first.items[0]!.group!.nextRecordOffset,
      upperSequence: first.upperSequence,
    },
    f.owner,
  );
  expect(continuation.items[0]!.group!.records.length).toBe(4);
  expect(continuation.items[0]!.group!.nextRecordOffset).toBe(null);
  expect(
    new Set(
      [...first.items[0]!.group!.records, ...continuation.items[0]!.group!.records].map(
        (r) => r.id,
      ),
    ).size,
  ).toBe(24);
  expect(first.items[0]!.group!.records.some((r: any) => r.card?.body)).toBeTruthy();
  await f.claim({ title: "New activity after the pinned upper sequence" });
  const next = await f.service.recent(
    {
      groupBySource: true,
      limit: 1,
      upperSequence: first.upperSequence,
      beforeSequence: first.nextBefore,
    },
    f.owner,
  );
  expect(next.items[0]!.group!.source.id).toBe(sourceB.id);
  expect(next.items[0]!.group!.counts.commitment).toBe(1);
  expect(next.nextBefore).toBe(null);
});

it("Recent batches attendee summaries only for the current group page", async () => {
  const f = await setup(),
    person = await f.page("Alex", "person");
  for (let i = 0; i < 21; i++) {
    await f.service.create_relationship(
      {
        requestId: randomUUID(),
        expectedOntologyFingerprint: f.fingerprint,
        title: `Attendance ${i}`,
        body: "Alex attended.",
        from: person.id,
        to: f.source.id,
        label: "attended",
        evidence: f.evidence,
        attribution: "Synthetic fixture",
        source_page: f.source.id,
      },
      f.owner,
    );
  }
  const input = {
    groupBySource: true,
    sourceId: f.source.id,
    includeEndpoints: true,
    limit: 1,
  };
  const first = await f.service.recent(input, f.owner);
  expect(Check(contract.operations.recent.output, first)).toBeTruthy();
  const group = first.items[0]!.group;
  expect(group!.records.length).toBe(20);
  expect(new Set(group!.endpoints!.map((r: any) => r.id))).toStrictEqual(
    new Set([person.id, f.source.id]),
  );
  expect(
    group!.endpoints!.every((r: any) => r.body === undefined && r.evidence === undefined),
  ).toBeTruthy();
  const next = await f.service.recent(
    { ...input, recordOffset: group!.nextRecordOffset, upperSequence: first.upperSequence },
    f.owner,
  );
  expect(next.items[0]!.group!.records.length).toBe(2);
  expect(new Set(next.items[0]!.group!.endpoints!.map((r: any) => r.id))).toStrictEqual(
    new Set([person.id, f.source.id]),
  );
  expect(
    (await f.service.recent({ ...input, includeEndpoints: false }, f.owner)).items[0]!.group!
      .endpoints,
  ).toBe(undefined);
  const record = (await f.service.record({ id: person.id }, f.owner)).record;
  await f.service.withdraw(
    {
      requestId: randomUUID(),
      id: person.id,
      expectedRevision: record!.revision,
      expectedHash: record!.hash,
      reason: "Fixture withdrawal",
    },
    f.owner,
  );
  const after = await f.service.recent({ ...input, upperSequence: first.upperSequence }, f.owner);
  expect(
    after.items.every((item: any) => !item.group?.endpoints!.some((r: any) => r.id === person.id)),
    "Pinned history cannot expose a now-withdrawn endpoint",
  ).toBeTruthy();
});

it("entity annotations link a claim by ID without changing its assertion, and reject non-pages, withdrawn pages and page targets", async () => {
  const f = await setup(),
    alex = await f.page("Alex", "person"),
    sam = await f.page("Sam", "person"),
    claim = await f.claim();
  const before = (await f.service.record({ id: claim.id, includeMetadata: true }, f.owner)).record;
  expect(before!.metadata!.entities).toBe(undefined);
  const { input } = await f.annotate(
    claim.id,
    {},
    { entities: [alex.id], reason: "Relink unique subject" },
  );
  const linked = (await f.service.record({ id: claim.id, includeMetadata: true }, f.owner)).record;
  expect(linked!.metadata!.entities).toStrictEqual([alex.id]);
  expect(linked!.body).toBe(before!.body);
  expect(linked!.lifecycle).toBe("active");
  expect(linked!.metadata!.supersedes).toBe(undefined);
  expect(linked!.metadata!.evidence).toStrictEqual(before!.metadata!.evidence);
  expect(linked!.revision).toBe(before!.revision + 1);
  const connected = await f.service.connections({ id: alex.id, direction: "claims" }, f.owner);
  expect(
    connected.connections.some((c: any) => c.record.id === claim.id),
    "The subject page now lists the claim",
  ).toBeTruthy();
  // Exact replay returns the same receipt; a stale revision conflicts.
  expect((await f.service.annotate(input, f.owner)).revision).toBe(linked!.revision);
  await expect(
    f.service.annotate({ ...input, requestId: randomUUID(), entities: [sam.id] }, f.owner),
  ).rejects.toThrow(/conflict/);
  await expect(f.annotate(claim.id, {}, { entities: [claim.id] })).rejects.toThrow(/active pages/);
  await expect(f.annotate(alex.id, {}, { entities: [sam.id] })).rejects.toThrow(/require a claim/);
  const samRecord = (await f.service.record({ id: sam.id }, f.owner)).record;
  await f.service.withdraw(
    {
      requestId: randomUUID(),
      id: sam.id,
      expectedRevision: samRecord!.revision,
      expectedHash: samRecord!.hash,
      reason: "Fixture withdrawal",
    },
    f.owner,
  );
  await expect(f.annotate(claim.id, {}, { entities: [sam.id] })).rejects.toThrow(/active pages/);
  await f.annotate(claim.id, {}, { entities: [] });
  expect(
    (await f.service.record({ id: claim.id, includeMetadata: true }, f.owner)).record!.metadata!
      .entities,
  ).toBe(undefined);
});
