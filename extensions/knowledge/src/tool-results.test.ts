import { randomUUID } from "node:crypto";
import type { OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it } from "vitest";
import { HASH_PREFIX_CHARS, hashMatches } from "./hash-fence.js";
import plugin from "./index.js";
import { sessionActions, storeFixture, toolContext, useTestTempDirs } from "./test-support.js";

const dirs = useTestTempDirs();

// Drive the registered agent tools and session actions: the real feature entry,
// its schema validation and the model-visible JSON text.
async function registered() {
  const factories = new Map<string, OpenClawPluginToolFactory>();
  const actions = new Map<string, any>();
  const f = await storeFixture(dirs.make("knowledge-lean-"), {
    policy: { writesEnabled: true, operatorRead: true },
    extra: {
      ...sessionActions((action: any) => actions.set(action.id, action)),
      registerTool(factory: OpenClawPluginToolFactory, options: { name: string }) {
        factories.set(options.name, factory);
      },
    },
  });
  plugin.register(f.api);
  const context = toolContext(f.api).tool;
  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const tool = factories.get(name)?.(context);
    if (!tool || Array.isArray(tool)) {
      throw new Error("Expected registered tool " + name);
    }
    const result = await tool.execute(randomUUID(), input);
    const [content] = result.content as { type: "text"; text: string }[];
    return { value: result.details as any, chars: content!.text.length };
  };
  const tool = async (name: string, input: Record<string, unknown> = {}) =>
    (await call(name, input)).value;
  const ui = async (operation: string, payload: Record<string, unknown>) => {
    const response = await actions
      .get(operation)
      .handler({ payload, client: { connId: "lean", scopes: ["operator.write"] } });
    expect(response.ok, response.error).toBe(true);
    return response.result;
  };
  return { f, call, tool, ui };
}

async function seeded() {
  const t = await registered();
  const status = await t.tool("knowledge_status");
  const upload = await t.tool("knowledge_attach", {
    requestId: randomUUID(),
    filename: "meeting.txt",
    mediaType: "text/plain",
    attribution: "Meeting transcript",
    offset: 0,
    data: Buffer.from("Alex: We chose option B.\n").toString("base64"),
    final: true,
  });
  const evidence = { ...upload.evidence, start_line: 1, end_line: 1, quote: "We chose option B." };
  const page = (title: string, type: string, extra: Record<string, unknown> = {}) =>
    t.tool("knowledge_save_page", {
      requestId: randomUUID(),
      title,
      type,
      body: "# " + title + "\n\nAuthored text about option B.\n",
      ...extra,
    });
  const person = await page("Alex Rivera", "person", { aliases: ["Alex"] });
  const project = await page("Garden Pilot", "project");
  const meeting = await page("Planning sync", "meeting");
  const claim = await t.tool("knowledge_create_claim", {
    requestId: randomUUID(),
    expectedOntologyFingerprint: meeting.ontologyFingerprint,
    title: "Option B decision",
    body: "Alex chose option B. <!-- project: path:/tmp/garden -->",
    claim_kind: "decision",
    assertion_origin: "source",
    attribution: "Alex, meeting transcript line 1",
    evidence: [evidence],
    entities: [project.id, person.id],
    source_page: meeting.id,
    occurred_at: "2026-09-23",
  });
  const edge = await t.tool("knowledge_create_relationship", {
    requestId: randomUUID(),
    expectedOntologyFingerprint: meeting.ontologyFingerprint,
    title: "Meeting discusses project",
    body: "Explicit meeting/project connection",
    from: meeting.id,
    to: project.id,
    label: "discusses",
    attribution: "Meeting transcript",
    evidence: [evidence],
  });
  return { ...t, status, upload, evidence, person, project, meeting, claim, edge };
}

const prefix = (hash: string) => hash.slice(0, HASH_PREFIX_CHARS);

it("agent write receipts carry the new revision, full hash and ontology fingerprint only", async () => {
  const s = await seeded();
  expect(s.status).toEqual({
    vault: expect.any(String),
    agent: "main",
    store: "ready",
    writesEnabled: true,
    records: expect.any(Number),
    ontologyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  for (const receipt of [s.person, s.project, s.meeting, s.claim, s.edge]) {
    const { git, ...rest } = receipt;
    expect(rest).toEqual({
      id: expect.any(String),
      revision: 1,
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      ontologyFingerprint: s.status.ontologyFingerprint,
    });
    // A local Git checkpoint appears only when it needs attention.
    expect(git === undefined || git.state !== "committed").toBe(true);
  }
  // The targeted recovery tool keeps the complete receipt.
  const full = await s.tool("knowledge_history", { id: s.person.id });
  expect(full.mutations[0]).toMatchObject({
    state: "published",
    indexed: false,
    path: expect.any(String),
  });
  // Operators and the Control UI always get the complete status.
  expect(await s.ui("status", {})).toMatchObject({
    service: "knowledge",
    limits: expect.any(Object),
  });
  expect(await s.tool("knowledge_status", { detail: "full" })).toMatchObject({
    instanceId: expect.any(String),
  });
});

it("connections default to one lean row per connection, with claim text", async () => {
  const s = await seeded();
  const lean = await s.tool("knowledge_connections", { id: s.project.id });
  expect(lean.snapshot).toBeUndefined();
  expect(lean.connections).toContainEqual({
    direction: "claims",
    id: s.claim.id,
    revision: 1,
    hash: prefix(s.claim.hash),
    claimKind: "decision",
    date: "2026-09-23",
    text: "Alex chose option B.",
    about: expect.arrayContaining(["Garden Pilot", "Alex Rivera"]),
    source: { id: s.meeting.id, title: "Planning sync" },
  });
  expect(lean.connections).toContainEqual({
    direction: "incoming",
    id: s.edge.id,
    title: "Meeting discusses project",
    type: "discusses",
    from: s.meeting.id,
    to: s.project.id,
    revision: 1,
    hash: prefix(s.edge.hash),
  });
  const full = await s.tool("knowledge_connections", {
    id: s.project.id,
    view: "full",
    includeCards: true,
  });
  const claim = full.connections.find((c: any) => c.record.id === s.claim.id);
  expect(claim.record).toMatchObject({ path: expect.any(String), card: { hash: s.claim.hash } });
  expect(full.snapshot).toMatch(/^[a-f0-9]{64}$/);
  // A two-row page carries the snapshot needed to compare the next page.
  const paged = await s.tool("knowledge_connections", { id: s.project.id, limit: 1 });
  expect(paged).toMatchObject({ nextOffset: 1, snapshot: full.snapshot });
});

it("records return identity, text and full hash; explicit options add what they name", async () => {
  const s = await seeded();
  expect(await s.tool("knowledge_record", { id: s.person.id })).toEqual({
    record: {
      id: s.person.id,
      revision: 1,
      hash: s.person.hash,
      title: "Alex Rivera",
      type: "person",
      aliases: ["Alex"],
      body: "# Alex Rivera\n\nAuthored text about option B.\n",
    },
  });
  expect(await s.tool("knowledge_record", { id: s.claim.id })).toEqual({
    record: {
      id: s.claim.id,
      revision: 1,
      hash: s.claim.hash,
      claimKind: "decision",
      date: "2026-09-23",
      about: expect.arrayContaining([
        { id: s.project.id, title: "Garden Pilot" },
        { id: s.person.id, title: "Alex Rivera" },
      ]),
      source: { id: s.meeting.id, title: "Planning sync" },
      attribution: "Alex, meeting transcript line 1",
      text: "Alex chose option B.",
    },
  });
  const evidence = await s.tool("knowledge_record", { id: s.claim.id, includeEvidence: true });
  // Verified citations omit the flag; only an unverified one says so.
  expect(evidence.evidence[0]).toMatchObject({
    path: s.evidence.path,
    excerpt: expect.any(String),
  });
  expect(evidence.evidence[0].verified).toBeUndefined();
  expect(evidence.metadata).toBeUndefined();
  const metadata = await s.tool("knowledge_record", { id: s.claim.id, metadataView: "full" });
  expect(metadata.metadata).toMatchObject({ claim_kind: "decision", evidence: expect.any(Array) });
  expect(metadata.evidence).toBeUndefined();
  const references = await s.tool("knowledge_record", { id: s.claim.id, includeReferences: true });
  expect(references.references).toContainEqual({
    id: s.meeting.id,
    title: "Planning sync",
    type: "meeting",
    revision: 1,
    hash: prefix(s.meeting.hash),
  });
  const full = await s.tool("knowledge_record", { id: s.claim.id, detail: "full" });
  expect(full).toMatchObject({ view: "content", record: { path: expect.any(String) } });
  expect(await s.ui("record", { id: s.claim.id })).toMatchObject({ view: "content" });
  expect(await s.tool("knowledge_record", { id: "missing-record-id" })).toEqual({ record: null });
});

it("maxChars bounds the whole record response and continues by offset", async () => {
  const s = await seeded();
  const body = Array.from({ length: 400 }, (_, i) => "Line " + i + " of the long page.").join("\n");
  const saved = await s.tool("knowledge_save_page", {
    requestId: randomUUID(),
    title: "Long page",
    type: "project",
    body,
  });
  let offset: number | undefined = 0,
    read = "",
    reads = 0;
  while (offset !== undefined) {
    const page = await s.call("knowledge_record", { id: saved.id, offset, maxChars: 1000 });
    expect(JSON.stringify(page.value).length).toBeLessThanOrEqual(1000);
    expect(page.value.record.hash).toBe(saved.hash);
    read += page.value.record.body;
    offset = page.value.nextOffset;
    if (offset !== undefined) {
      expect(page.value.totalChars).toBe(body.length);
    }
    reads++;
  }
  expect(read).toBe(body);
  expect(reads).toBeGreaterThan(body.length / 1000);
});

it("search, lookup, timeline, records, ontology, verify and passages default to lean shapes", async () => {
  const s = await seeded();
  const grep = await s.tool("knowledge_grep", { query: "option" });
  expect(grep.hits).toContainEqual({
    id: s.person.id,
    title: "Alex Rivera",
    type: "person",
    revision: 1,
    hash: prefix(s.person.hash),
    snippet: expect.any(String),
  });
  const claimHit = grep.hits.find((h: any) => h.id === s.claim.id);
  expect(claimHit).toMatchObject({ kind: "claim", type: "decision", hash: prefix(s.claim.hash) });
  expect(claimHit.title).toBeUndefined();
  expect(claimHit.snippet).not.toContain("<!--");
  expect(Object.keys(grep).toSorted()).toEqual(["hits", "resultCount", "total"]);
  const fullGrep = await s.tool("knowledge_grep", { query: "option", detail: "full" });
  expect(fullGrep.hits[0]).toMatchObject({
    citation: expect.any(Object),
    score: expect.anything(),
  });
  expect(await s.tool("knowledge_lookup", { query: "Alex" })).toEqual({
    outcome: "found",
    hits: [
      {
        id: s.person.id,
        title: "Alex Rivera",
        type: "person",
        revision: 1,
        hash: prefix(s.person.hash),
      },
    ],
    resultCount: 1,
    total: 1,
  });
  const timeline = await s.tool("knowledge_timeline", { entity: s.project.id });
  expect(timeline).toEqual({
    items: [
      {
        date: "2026-09-23",
        id: s.claim.id,
        type: "decision",
        revision: 1,
        hash: prefix(s.claim.hash),
        summary: "Alex chose option B.",
      },
    ],
    total: 1,
  });
  expect(await s.tool("knowledge_chronicle_last_seen", { entity: s.project.id })).toEqual({
    entity: s.project.id,
    last: timeline.items[0],
  });
  const records = await s.tool("knowledge_records", { kind: "claim", includeCards: true });
  expect(records.records).toEqual([
    {
      id: s.claim.id,
      revision: 1,
      hash: prefix(s.claim.hash),
      claimKind: "decision",
      date: "2026-09-23",
      text: "Alex chose option B.",
      about: expect.any(Array),
      source: { id: s.meeting.id, title: "Planning sync" },
    },
  ]);
  expect(await s.tool("knowledge_records", { kind: "page", query: "Alex" })).toMatchObject({
    records: [
      {
        id: s.person.id,
        title: "Alex Rivera",
        type: "person",
        revision: 1,
        hash: prefix(s.person.hash),
      },
    ],
    total: 1,
  });
  const ontology = await s.tool("knowledge_ontology", { kind: "page", limit: 2 });
  expect(ontology.fingerprint).toBe(s.status.ontologyFingerprint);
  expect(Object.keys(ontology.definitions[0]).toSorted()).toEqual(["description", "kind", "name"]);
  expect(ontology.nextOffset).toBe(2);
  const verify = await s.tool("knowledge_verify", {
    records: [{ id: s.claim.id, expectedRevision: 1, expectedHash: prefix(s.claim.hash) }],
  });
  expect(verify).toEqual({ checked: 1, passed: 1, failed: 0 });
  const passage = await s.tool("knowledge_evidence_read", {
    id: s.claim.id,
    path: s.evidence.path,
    sha256: s.evidence.sha256,
  });
  expect(passage).toEqual({
    text: "Alex: We chose option B.\n",
    range: { startLine: 1, endLine: 2 },
  });
});

it("write fences accept a 16+ character hash prefix and reject short, wrong or stale fences", async () => {
  const s = await seeded();
  const edit = (expectedHash: string, expectedRevision = 1) =>
    s.tool("knowledge_save_page", {
      requestId: randomUUID(),
      id: s.person.id,
      expectedRevision,
      expectedHash,
      title: "Alex Rivera",
      type: "person",
      body: "# Alex Rivera\n\nEdited.\n",
    });
  await expect(edit(s.person.hash.slice(0, HASH_PREFIX_CHARS - 1))).rejects.toThrow(/expectedHash/);
  await expect(edit("0".repeat(HASH_PREFIX_CHARS))).rejects.toThrow(/Edit conflict/);
  await expect(edit(prefix(s.person.hash), 2)).rejects.toThrow(/Edit conflict/);
  const edited = await edit(prefix(s.person.hash));
  expect(edited).toMatchObject({ id: s.person.id, revision: 2 });
  // The superseded hash no longer fences the page.
  await expect(edit(prefix(s.person.hash), 2)).rejects.toThrow(/Edit conflict/);
  // A list row's hash fences annotate and withdraw directly.
  const row = (await s.tool("knowledge_connections", { id: s.project.id, direction: "claims" }))
    .connections[0];
  const annotated = await s.tool("knowledge_annotate", {
    requestId: randomUUID(),
    id: row.id,
    expectedRevision: row.revision,
    expectedHash: row.hash,
    reason: "Link the meeting attendee",
    annotations: {},
    entities: [s.project.id],
  });
  expect(annotated).toMatchObject({ id: row.id, revision: 2 });
  await expect(
    s.tool("knowledge_withdraw", {
      requestId: randomUUID(),
      id: row.id,
      expectedRevision: 2,
      expectedHash: row.hash,
      reason: "Stale fence",
    }),
  ).rejects.toThrow(/Lifecycle conflict/);
  const withdrawn = await s.tool("knowledge_withdraw", {
    requestId: randomUUID(),
    id: row.id,
    expectedRevision: 2,
    expectedHash: prefix(annotated.hash),
    reason: "Duplicate of a later decision",
  });
  expect(withdrawn.id).toBeDefined();
});

it("hashMatches accepts the full hash or a 16+ character lowercase prefix", () => {
  const hash = "a".repeat(32) + "b".repeat(32);
  expect(hashMatches(hash, hash)).toBe(true);
  expect(hashMatches(hash, hash.slice(0, 16))).toBe(true);
  expect(hashMatches(hash, "b".repeat(16))).toBe(false);
  expect(() => hashMatches(hash, hash.slice(0, 15))).toThrow(/at least|16 or more/);
  expect(() => hashMatches(hash, hash.slice(0, 16).toUpperCase())).toThrow(/lowercase/);
});

it("lean agent responses are a fraction of the complete ones", async () => {
  const s = await seeded();
  const pairs: [string, Record<string, unknown>, Record<string, unknown>][] = [
    [
      "knowledge_connections",
      { id: s.project.id },
      { id: s.project.id, view: "full", includeCards: true },
    ],
    ["knowledge_record", { id: s.claim.id }, { id: s.claim.id, detail: "full" }],
    ["knowledge_grep", { query: "option" }, { query: "option", detail: "full" }],
    ["knowledge_lookup", { query: "Alex" }, { query: "Alex", detail: "full" }],
    ["knowledge_timeline", { entity: s.project.id }, { entity: s.project.id, detail: "full" }],
    ["knowledge_records", { includeCards: true }, { includeCards: true, detail: "full" }],
    ["knowledge_ontology", {}, { detail: "full" }],
    ["knowledge_status", {}, { detail: "full" }],
  ];
  for (const [name, lean, full] of pairs) {
    const [a, b] = [await s.call(name, lean), await s.call(name, full)];
    expect(a.chars, name).toBeLessThan(b.chars * 0.6);
  }
});
