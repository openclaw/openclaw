import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import { SqliteIdentityStore } from "./identity-store.js";
import { createKnowledgeService } from "./service.js";
import { KnowledgeStorage } from "./storage.js";
import {
  accessFor,
  operatorContext,
  storeFixture,
  toolContext,
  useTestTempDirs,
} from "./test-support.js";

const tempDirs = useTestTempDirs();

const draft = () => ({
  requestId: randomUUID(),
  title: "Publication test",
  type: "note",
  body: "Authored text.\n",
});
const edit = (record: any, fields = {}) => ({
  requestId: randomUUID(),
  id: record.id,
  expectedRevision: record.revision,
  expectedHash: record.hash,
  title: record.title,
  body: record.body,
  ...fields,
});

async function foundation() {
  const f: any = await storeFixture(tempDirs.make("knowledge-structured-"), {
    policy: { writesEnabled: true, operatorRead: true },
  });
  f.owner = toolContext(f.api);
  f.operator = operatorContext(f.api);
  f.service = createKnowledgeService(f.api);
  f.store = new SqliteIdentityStore(f.config.statePath);
  f.access = () => accessFor(f.owner, true);
  f.fingerprint = (await f.service.ontology({}, f.owner)).fingerprint;
  f.pages = {};
  for (const type of ["person", "project", "meeting"]) {
    f.pages[type] = await f.service.save_page({ ...draft(), title: type, type }, f.owner);
  }
  f.source = await f.service.attach(
    {
      requestId: randomUUID(),
      filename: "meeting.txt",
      mediaType: "text/plain",
      attribution: "Meeting transcript",
      offset: 0,
      data: Buffer.from(
        "Alex: We chose option B.\nAlex: I will deliver by Friday.\nSpeaker 2: I disagree.",
      ).toString("base64"),
      final: true,
    },
    f.owner,
  );
  f.evidence = {
    ...f.source.evidence,
    start_line: 1,
    end_line: 1,
    quote: "We chose option B.",
  };
  f.claim = (extra = {}) => ({
    requestId: randomUUID(),
    expectedOntologyFingerprint: f.fingerprint,
    title: "Option B decision",
    body: "Alex chose option B.",
    claim_kind: "decision",
    assertion_origin: "source",
    attribution: "Alex, meeting transcript line 1",
    evidence: [f.evidence],
    entities: [f.pages.project.id],
    dependencies: [f.pages.meeting.id],
    ...extra,
  });
  f.edge = (extra = {}) => ({
    requestId: randomUUID(),
    expectedOntologyFingerprint: f.fingerprint,
    title: "Meeting discusses project",
    body: "Explicit meeting/project connection",
    from: f.pages.meeting.id,
    to: f.pages.project.id,
    label: "discusses",
    attribution: "Meeting transcript",
    evidence: [f.evidence],
    ...extra,
  });
  return f;
}

it("structured UI/agent service parity: decision, owned commitment, event, edge and exact evidence", async () => {
  const f = await foundation();
  const decision = await f.service.create_claim(f.claim(), f.owner);
  const commitment = await f.service.create_claim(
    f.claim({
      title: "Deliver",
      claim_kind: "commitment",
      owner: f.pages.person.id,
      due_at: "2026-09-25",
      occurred_at: "2026-09-23T10:30:00-07:00",
    }),
    f.operator,
  );
  const event = await f.service.create_claim(
    f.claim({ title: "Historical event", claim_kind: "event", occurred_at: "2020-02-29" }),
    f.owner,
  );
  const edge = await f.service.create_relationship(f.edge(), f.operator);
  for (const receipt of [decision, commitment, event, edge]) {
    expect(receipt.state).toBe("published");
    expect(Check(contract.operations.create_claim.output, receipt)).toBeTruthy();
    const read = await f.service.record(
      { id: receipt.id, includeMetadata: true, includeEvidence: true },
      f.owner,
    );
    expect(Check(contract.operations.record.output, read)).toBeTruthy();
    expect(read.evidence![0]!.verified).toBe(true);
    expect(read.evidence![0]!.quote).toBe("We chose option B.");
    expect((await f.service.lookup({ query: receipt.id }, f.owner)).outcome).toBe("found");
  }
  const m = (await f.service.record({ id: commitment.id, includeMetadata: true }, f.owner)).record!
    .metadata;
  expect(m!.owner).toBe(f.pages.person.id);
  expect(m!.due_at).toBe("2026-09-25");
  expect(m!.occurred_at).toBe("2026-09-23T10:30:00-07:00");
  const outgoing = await f.service.connections(
    { id: f.pages.meeting.id, direction: "outgoing" },
    f.owner,
  );
  expect(Check(contract.operations.connections.output, outgoing)).toBeTruthy();
  expect(outgoing.connections[0]!.record.id).toBe(edge.id);
  expect(
    (await f.service.connections({ id: f.pages.project.id, direction: "incoming" }, f.operator))
      .connections[0]!.from,
  ).toBe(f.pages.meeting.id);
  const reverse = await f.service.connections(
    { id: f.pages.meeting.id, direction: "dependents", limit: 1 },
    f.owner,
  );
  expect(reverse.total).toBe(3);
  expect(reverse.nextOffset).toBe(1);
  expect(
    (await f.service.connections({ id: f.pages.person.id, direction: "claims" }, f.owner))
      .connections[0]!.record.id,
  ).toBe(commitment.id);
});

it("all claim kinds roundtrip; contradictions and uncertain attribution are not merged", async () => {
  const f = await foundation();
  for (const claim_kind of ["fact", "preference", "decision", "commitment", "event", "belief"]) {
    for (const assertion_origin of ["source", "user_belief", "agent_inference"]) {
      const receipt = await f.service.create_claim(
        f.claim({ claim_kind, assertion_origin, attribution: "Unresolved Speaker 2" }),
        f.owner,
      );
      const r = (await f.service.record({ id: receipt.id, includeMetadata: true }, f.owner)).record;
      expect(r!.metadata!.claim_kind).toBe(claim_kind);
      expect(r!.metadata!.assertion_origin).toBe(assertion_origin);
      expect(r!.metadata!.owner).toBe(undefined);
    }
  }
  const opposite = await f.service.create_claim(
    f.claim({ body: "Speaker 2 rejects option B." }),
    f.owner,
  );
  expect((await f.service.records({ kind: "claim" }, f.owner)).total).toBe(19);
  expect((await f.service.record({ id: opposite.id }, f.owner)).record!.body).toBe(
    "Speaker 2 rejects option B.",
  );
});

it("automatic recall approval rejects source and agent-inference claims", async () => {
  const f = await foundation(),
    outcomes = [];
  for (const assertion_origin of ["source", "agent_inference", "user_belief"]) {
    const receipt = await f.service.create_claim(
      f.claim({ assertion_origin, attribution: "Josh, direct owner statement" }),
      f.owner,
    );
    const record = (await f.service.record({ id: receipt.id }, f.owner)).record;
    const approval = f.service.recall(
      {
        requestId: randomUUID(),
        id: record!.id,
        expectedRevision: record!.revision,
        expectedHash: record!.hash,
        set: { summary: "Josh prefers option B.", triggers: ["option B"] },
      },
      f.owner,
    );
    outcomes.push(
      await approval.then(
        (r: any) => r.state,
        (e: Error) => e.message,
      ),
    );
  }
  expect(outcomes).toStrictEqual([
    expect.stringMatching(/externally sourced or agent-inferred/),
    expect.stringMatching(/externally sourced or agent-inferred/),
    "published",
  ]);
});

for (const operation of ["create_claim", "create_relationship"] as const) {
  for (const stage of ["after-accept", "after-link:vault.json", "before-receipt"]) {
    it(`${operation}: interrupted ${stage}, replacement retry and changed payload`, async () => {
      const f = await foundation(),
        input = operation === "create_claim" ? f.claim() : f.edge();
      const publisher = new KnowledgeStorage(f.config, f.store, (where) => {
        if (where === stage) {
          throw new Error("crash");
        }
      });
      const method = operation === "create_claim" ? "createClaim" : "createRelationship";
      await expect(publisher[method](input, f.access(), "agent")).rejects.toThrow(/crash/);
      const resumed = await createKnowledgeService(f.api)[operation](input, f.owner);
      expect(resumed.state).toBe("published");
      expect(await f.service[operation](input, f.owner)).toStrictEqual(resumed);
      await expect(f.service[operation]({ ...input, title: "Different" }, f.owner)).rejects.toThrow(
        /different payload/,
      );
      await expect(
        f.service.save_page({ ...draft(), requestId: input.requestId }, f.owner),
      ).rejects.toThrow(/different payload/);
      expect(
        (
          await f.service.records(
            { kind: operation === "create_claim" ? "claim" : "relationship" },
            f.owner,
          )
        ).total,
      ).toBe(1);
    });
  }
}

it("malformed writes and references fail before acceptance with no source mutation", async () => {
  const f = await foundation();
  for (const change of [
    { evidence: [] },
    { evidence: [{ ...f.evidence, quote: "not in source" }] },
    { evidence: [{ ...f.evidence, end_line: 999 }] },
    { claim_kind: undefined },
    { assertion_origin: undefined },
    { attribution: " " },
    { body: " " },
    { expectedOntologyFingerprint: "0".repeat(64) },
    { entities: [randomUUID()] },
    { owner: f.pages.person.id },
    { due_at: "2026-09-30" },
    { occurred_at: "2026-02-30" },
    { occurred_at: "2026-09-23T10:00:00" },
    { occurred_at: "2026-09-23T24:00:00Z" },
    { valid_from: "2026-09-23T00:00:00Z", valid_until: "2026-09-22T00:00:00Z" },
    { lifecycle: "withdrawn" },
    { id: randomUUID() },
  ]) {
    const input = f.claim(change);
    await expect(f.service.create_claim(input, f.owner)).rejects.toThrow();
    expect((await f.service.mutation({ requestId: input.requestId }, f.owner)).receipt).toBe(null);
  }
  const c = await f.service.create_claim(f.claim(), f.owner);
  await expect(f.service.create_relationship(f.edge({ from: c.id }), f.owner)).rejects.toThrow(
    /pages/,
  );
  await expect(
    f.service.create_relationship(f.edge({ label: "not_declared" }), f.owner),
  ).rejects.toThrow(/ontology/);
  await expect(f.service.create_relationship(f.edge({ label: "leads" }), f.owner)).rejects.toThrow(
    /endpoint-type/,
  );
  expect((await f.service.records({ kind: "relationship" }, f.owner)).total).toBe(0);
});

it("temporal active retrieval and connections agree; explicit history keeps expired assertions", async () => {
  const f = await foundation();
  const expired = await f.service.create_claim(
    f.claim({ expires_at: "2000-01-01T00:00:00Z" }),
    f.owner,
  );
  const future = await f.service.create_relationship(
    f.edge({ valid_from: "2099-01-01T00:00:00Z" }),
    f.owner,
  );
  const ended = await f.service.create_claim(
    f.claim({ valid_until: "2000-01-01T00:00:00Z" }),
    f.owner,
  );
  for (const r of [expired, future, ended]) {
    expect((await f.service.lookup({ query: r.id }, f.owner)).outcome).toBe("missing");
    expect((await f.service.lookup({ query: r.id, lifecycle: "all" }, f.owner)).outcome).toBe(
      "found",
    );
    expect((await f.service.record({ id: r.id }, f.owner)).record).toBeTruthy();
    await expect(
      f.service.create_claim(f.claim({ dependencies: [r.id] }), f.owner),
    ).rejects.toThrow(/unavailable/);
  }
  expect((await f.service.grep({ query: "option" }, f.owner)).total).toBe(0);
  expect((await f.service.grep({ query: "option", lifecycle: "all" }, f.owner)).total).toBe(2);
  expect((await f.service.connections({ id: f.pages.project.id }, f.owner)).total).toBe(0);
  expect(
    (await f.service.connections({ id: f.pages.project.id, historical: true }, f.owner)).total,
  ).toBe(3);
});

it("metadata omission preserves, empty clears, authored fields/comments survive, aliases stay ambiguous", async () => {
  const f = await foundation();
  let r = (await f.service.record({ id: f.pages.person.id }, f.owner)).record;
  await f.service.save_page(
    edit(r, {
      aliases: ["Alex"],
      tags: ["team"],
      dependencies: [f.pages.meeting.id],
      fields: { role: "Engineer" },
    }),
    f.owner,
  );
  r = (await f.service.record({ id: r!.id }, f.owner)).record;
  await f.service.save_page(edit(r, { title: "Alex person" }), f.owner);
  let m = (await f.service.record({ id: r!.id, includeMetadata: true }, f.owner)).record!.metadata;
  expect(m!.aliases).toStrictEqual(["Alex"]);
  expect(m!.dependencies).toStrictEqual([f.pages.meeting.id]);
  await f.service.save_page({ ...draft(), aliases: ["Alex"] }, f.owner);
  expect((await f.service.lookup({ query: "Alex" }, f.owner)).outcome).toBe("ambiguous");
  r = (await f.service.record({ id: r!.id }, f.owner)).record;
  await f.service.save_page(edit(r, { aliases: [], tags: [], dependencies: [] }), f.owner);
  m = (await f.service.record({ id: r!.id, includeMetadata: true }, f.owner)).record!.metadata;
  expect(m!.aliases).toStrictEqual([]);
  expect(m!.tags).toStrictEqual([]);
  expect(m!.dependencies).toStrictEqual([]);
  expect(m!.fields).toStrictEqual({ role: "Engineer" });
});

it("new mutations and connections obey scope, read-only authority and historical withdrawal ledger", async () => {
  const f = await foundation(),
    input = f.claim(),
    receipt = await f.service.create_claim(input, f.owner);
  const readOnly = {
    ...f.operator,
    action: { client: { connId: "readonly", scopes: ["operator.read"] } },
  };
  await expect(f.service.create_claim(f.claim(), readOnly)).rejects.toThrow(/authority/);
  const original = await readFile(path.join(f.root, "private", receipt.path), "utf8");
  await writeFile(
    path.join(f.root, "private", receipt.path),
    original.replace("lifecycle: active", "lifecycle: withdrawn"),
  );
  expect(
    (await f.service.connections({ id: f.pages.project.id, historical: true }, f.owner)).total,
  ).toBe(0);
  await writeFile(path.join(f.root, "private", receipt.path), original);
  expect(
    (await f.service.connections({ id: f.pages.project.id, historical: true }, f.owner)).total,
  ).toBe(0);
  f.owner.tool.memoryAudience = {
    kind: "conversation",
    agentId: "main",
    sessionKey: "agent:main:group",
    sessionId: randomUUID(),
  };
  await expect(f.service.create_claim(f.claim(), f.owner)).rejects.toThrow(/unavailable/);
  await expect(f.service.create_relationship(f.edge(), f.owner)).rejects.toThrow(/unavailable/);
  expect(
    (await f.service.connections({ id: f.pages.project.id, historical: true }, f.owner)).total,
  ).toBe(0);
});

for (const target of ["reference", "evidence"]) {
  it(`fences ${target} changes between preview and acceptance`, async () => {
    const f = await foundation(),
      input = f.claim();
    const relative = target === "reference" ? f.pages.project.path : f.evidence.path;
    const full = path.join(f.root, "private", relative),
      original = await readFile(full, "utf8");
    const publisher = new KnowledgeStorage(f.config, f.store, (stage) => {
      if (stage === "before-accept") {
        writeFileSync(full, original + "\nExternal change");
      }
    });
    await expect(publisher.createClaim(input, f.access(), "agent")).rejects.toThrow();
    expect((await f.service.mutation({ requestId: input.requestId }, f.owner)).receipt).toBe(null);
    expect((await f.service.records({ kind: "claim" }, f.owner)).total).toBe(0);
  });
}
