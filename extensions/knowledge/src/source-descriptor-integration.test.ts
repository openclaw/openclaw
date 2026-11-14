import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, rm, rmdir, link, symlink } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { fileStamp } from "./evidence-files.js";
import { GitHistory, GitUnavailable } from "./git-history.js";
import { SqliteIdentityStore } from "./identity-store.js";
import type { BatchInput } from "./ingestion-contract.js";
import type { Envelope, LoadedRecord } from "./model.js";
import { describeSource } from "./source-descriptors.js";
import { encodeRecordEvidence, hydrateMetadata, readSourceDescriptor } from "./source-records.js";
import type { PublicationHook } from "./storage-types.js";
import { KnowledgeStorage } from "./storage.js";
import { edit } from "./structured-write.test-support.js";
import {
  createVault,
  plainAccess,
  afterTest,
  useTestTempDirs,
  defaultOrder,
} from "./test-support.js";
import { SampleVault, digest, type ScanCache } from "./vault.js";

const tempDirs = useTestTempDirs();

// Keep every publication local to the fixture, without invoking Git or workers.
class NoGit extends GitHistory {
  override checkpoint(): never {
    throw new GitUnavailable("Git deliberately disabled in descriptor tests.");
  }
}
const frontmatter = (raw: any) => parse(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)![1]!);
const draft = (title: any, attachments: any[] = []) => ({
  requestId: randomUUID(),
  title,
  type: "note",
  body: title + "\n",
  attachments,
});

// Temporary stores use the real storage journal and scoped vault reader.
async function fixture() {
  const base = tempDirs.make("knowledge-descriptor-integration-");

  const f = await createVault(base),
    store = new SqliteIdentityStore(f.config.statePath);
  const access = plainAccess(),
    scoped = path.join(f.root, "private");
  const storage = (hook?: PublicationHook) =>
    new KnowledgeStorage(f.config, store, hook, new NoGit(f.root));
  return {
    ...f,
    base,
    store,
    access,
    scoped,
    storage,
    writer: storage(),
    read: (relative: any) => readFile(path.join(scoped, relative), "utf8"),
  };
}

// Retain predictable originals; distinct origins never rely on random hashes.
async function original(root: any, name = "meeting") {
  const text = name + " first line\n" + name + " second line\n";
  const evidence = {
    path: "artifacts/" + name + ".txt",
    sha256: digest(text),
    filename: name + ".txt",
    mediaType: "text/plain",
    size: Buffer.byteLength(text),
    attribution: "Recorder original",
  };
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  await writeFile(path.join(root, evidence.path), text);
  return evidence;
}

// Authored records let tests exercise raw YAML and the scanner independently.
// Metadata keeps unknown authored fields, so tests can read them back.
function authored(
  evidence: any,
  overrides = {},
  body = "Exact authored body.\n",
): LoadedRecord & { metadata: Record<string, unknown> } {
  const metadata: Envelope = {
    format: "knowledge-record-v1",
    id: "descriptor_note",
    revision: 1,
    kind: "page",
    type: "note",
    title: "Descriptor note",
    scope: { visibility: "private" },
    recorded_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    lifecycle: "active",
    evidence: [evidence],
    ...overrides,
  };
  const raw = "---\n" + stringify(metadata, { aliasDuplicateObjects: false }) + "---\n" + body;
  return {
    id: metadata.id,
    title: metadata.title,
    revision: metadata.revision,
    kind: "page",
    type: "note",
    lifecycle: "active",
    path: "notes/descriptor.md",
    valid: true,
    metadata,
    raw,
    body,
    hash: digest(raw),
  };
}

// Install only a compact record and its immutable descriptor in this partition.
async function install(root: any, evidence: any, overrides = {}) {
  const source = describeSource(evidence),
    record = authored({ source: source.id }, overrides);
  await mkdir(path.join(root, "artifacts/sources"), { recursive: true });
  await mkdir(path.join(root, "notes"), { recursive: true });
  await writeFile(path.join(root, source.path), source.raw);
  await writeFile(path.join(root, record.path), record.raw);
  return { source, record };
}

// Return the actual journal accepted plan, not an inferred list of files.
function planFor(f: any, requestId: any) {
  return f.store.withDatabase((db: any) =>
    JSON.parse(db.prepare("SELECT plan FROM mutations WHERE request=?").get(requestId).plan),
  );
}

// Read the fully hydrated domain record through the same scope as publication.
async function recordFor(f: any, id: any) {
  return f.writer.run(f.access, async (vault: any) =>
    (await vault.scan()).records.find((record: any) => record.id === id),
  );
}

it("same source deduplicates across records and a multi-source batch retains every descriptor", async () => {
  const f = await fixture(),
    shared = await original(f.scoped),
    other = await original(f.scoped, "other");
  const source = describeSource(shared),
    secondSource = describeSource(other);
  const first = await f.writer.save(draft("First", [shared]), f.access, "agent");
  const sourceStamp = fileStamp(f.scoped, source.path);
  const second = await f.writer.save(draft("Second", [shared]), f.access, "agent");
  expect(fileStamp(f.scoped, source.path), "reuse does not rewrite immutable bytes").toBe(
    sourceStamp,
  );
  for (const receipt of [first, second]) {
    expect(receipt.state).toBe("published");
    expect(frontmatter(await f.read(receipt.path)).evidence).toStrictEqual([{ source: source.id }]);
    expect((await recordFor(f, receipt.id)).metadata.evidence).toStrictEqual([
      { ...shared, source: source.id },
    ]);
  }
  const fingerprint = await f.writer.run(
    f.access,
    async (vault: any) => (await vault.scan()).ontology!.fingerprint,
  );
  const input: BatchInput = {
    requestId: randomUUID(),
    expectedVaultId: f.config.vaultId,
    expectedOntologyFingerprint: fingerprint,
    items: [shared, shared, other].map((evidence, index) => ({
      key: "note" + index,
      kind: "page",
      input: {
        title: "Batch " + index,
        type: "note",
        body: "Batch body\n",
        attachments: [evidence],
      },
    })),
  };
  const batch = await f.writer.batch(input, f.access, "agent"),
    plan = planFor(f, input.requestId);
  expect(batch.state).toBe("published");
  expect(batch.items!.length).toBe(3);
  expect(Object.keys(plan.descriptors).toSorted(defaultOrder)).toStrictEqual(
    [source.path, secondSource.path].toSorted(defaultOrder),
  );
  expect(
    (await readdir(path.join(f.scoped, "artifacts/sources"))).toSorted(defaultOrder),
  ).toStrictEqual([source.id + ".json", secondSource.id + ".json"].toSorted(defaultOrder));
  expect(
    plan.changes.some((change: any) => change.path === "private/" + source.path),
    "reused descriptor is a replay dependency, not a write",
  ).toBe(false);
  for (const [index, item] of batch.items!.entries()) {
    const expected = index === 2 ? secondSource : source;
    expect(frontmatter(await f.read(item.path)).evidence).toStrictEqual([{ source: expected.id }]);
    expect((await recordFor(f, item.id)).metadata.evidence[0].source).toBe(expected.id);
    expect(await f.read(expected.path)).toBe(expected.raw);
  }
});

it("encoding preserves exact body, unknown YAML, and all supported annotation evidence fields", async () => {
  const f = await fixture(),
    evidence = await original(f.scoped);
  const passage = { ...evidence, start_line: 1, end_line: 1, quote: "meeting first line" };
  const basis = { basis: "Retained passage", evidence: [passage] };
  const body = "\r\n# Exact Ω body  \r\n\r\n---\r\nNo trailing newline";
  const record = authored(
    passage,
    {
      custom: { evidence: [{ untouched: true }], nested: [1, "two"] },
      attribution_confidence: { level: "high", ...basis },
      identity: {
        status: "partial",
        context: "Keep this wording.",
        candidates: [{ id: "candidate_person", ...basis }],
      },
      continuity: [{ id: "previous_record", relation: "updates", ...basis }],
    },
    body,
  );
  record.raw = record.raw
    .replace("custom:\n", "# authored comment\ncustom:\n")
    .replace("title: Descriptor note", 'title: "Descriptor note"');
  const before = structuredClone(record),
    encoded = encodeRecordEvidence(record, () => {
      throw new Error("Unexpected legacy descriptor read");
    });
  expect(record, "encoding does not mutate the caller").toStrictEqual(before);
  expect(encoded.record.body).toBe(body);
  expect(encoded.record.raw.slice(encoded.record.raw.indexOf("\n---\n") + 5)).toBe(body);
  expect(encoded.record.raw.includes("# authored comment\ncustom:\n")).toBeTruthy();
  expect(encoded.record.raw.includes('title: "Descriptor note"')).toBeTruthy();
  const rawMetadata = frontmatter(encoded.record.raw),
    source = describeSource(evidence);
  expect(rawMetadata.custom).toStrictEqual(record.metadata.custom);
  expect(Object.keys(encoded.descriptors)).toStrictEqual([source.path]);
  const citation = { source: source.id, start_line: 1, end_line: 1, quote: passage.quote };
  for (const citations of [
    rawMetadata.evidence,
    rawMetadata.attribution_confidence.evidence,
    rawMetadata.identity.candidates[0].evidence,
    rawMetadata.continuity[0].evidence,
  ]) {
    expect(citations).toStrictEqual([citation]);
  }
  const hydrated: Record<string, unknown> = hydrateMetadata(
    rawMetadata,
    (relative) => encoded.descriptors[relative]!,
  );
  expect(hydrated.evidence).toStrictEqual([{ ...passage, source: source.id }]);
  expect(hydrated.custom).toStrictEqual(record.metadata.custom);
  expect(encoded.record.hash).toBe(digest(encoded.record.raw));
});

it("descriptor tamper, deletion and reappearance invalidate whole-scan and parsed-file caches without touching the record", async () => {
  const f = await fixture(),
    evidence = await original(f.scoped),
    { source, record } = await install(f.scoped, evidence);
  const cache: ScanCache = {},
    vault = new SampleVault(f.scoped, f.access.scope, false, undefined, cache);
  const recordStamp = fileStamp(f.scoped, record.path),
    descriptorFile = path.join(f.scoped, source.path);
  // Advance the cache clock beyond the filesystem race window instead of sleeping.
  const clock = vi.spyOn(Date, "now").mockImplementation(() => 4102444800000);
  afterTest(() => clock.mockRestore());
  const initial = await vault.scan();
  expect(initial.records[0]!.valid).toBe(true);
  expect(await vault.scan(), "whole-scan cache is genuinely warm").toBe(initial);
  expect(cache.files!.get(record.path)!.record, "parsed-file cache is genuinely warm").toBeTruthy();
  const initialTree = cache.entry!.tree;
  await writeFile(descriptorFile, source.raw.replace("Recorder original", "Recorder tampered"));
  const changed = await vault.scan();
  expect(changed).not.toBe(initial);
  expect(cache.entry!.tree, "descriptor-only mutation is outside the record tree stamp").toBe(
    initialTree,
  );
  expect(changed.records.length).toBe(0);
  expect(
    changed.issues.some((issue) => issue.path === record.path && issue.code === "invalid-record"),
  ).toBeTruthy();
  expect(cache.files!.get(record.path)!.record, "stale parsed evidence was discarded").toBe(
    undefined,
  );
  await writeFile(descriptorFile, source.raw);
  const restored = await vault.scan();
  expect(restored.records[0]!.valid).toBe(true);
  expect(await vault.scan()).toBe(restored);
  await rm(descriptorFile);
  const missing = await vault.scan();
  expect(missing.records.length).toBe(0);
  expect(missing.issues.some((issue) => issue.code === "invalid-record")).toBeTruthy();
  expect(
    cache.files!.has(record.path),
    "missing dependencies must not create settled negative cache entries",
  ).toBe(false);
  await writeFile(descriptorFile, source.raw);
  const reappeared = await vault.scan();
  expect(reappeared.records[0]!.valid).toBe(true);
  expect(reappeared.records[0]!.metadata.evidence).toStrictEqual([
    { ...evidence, source: source.id },
  ]);
  expect(await vault.scan()).toBe(reappeared);
  expect(fileStamp(f.scoped, record.path)).toBe(recordStamp);
});

it("scope is checked before hydration and a descriptor cannot resolve from a sibling partition", async () => {
  const f = await fixture(),
    evidence = await original(f.scoped),
    source = describeSource(evidence);
  await install(f.scoped, evidence, {
    scope: { visibility: "conversation", sessionId: "11111111-1111-1111-1111-111111111111" },
  });
  await rm(path.join(f.scoped, source.path));
  const cache: ScanCache = {},
    vault = new SampleVault(f.scoped, f.access.scope, false, undefined, cache);
  const clock = vi.spyOn(Date, "now").mockImplementation(() => 4102444800000);
  afterTest(() => clock.mockRestore());
  const wrong = await vault.scan();
  expect(wrong.records.length).toBe(0);
  expect(wrong.issues[0]!.message).toMatch(/scope.*does not match/);
  expect(
    cache.files!.get("notes/descriptor.md")!.descriptors.size,
    "no descriptor was consulted for a foreign-scope record",
  ).toBe(0);
  expect(cache.entry!.evidence.size).toBe(0);
  // A correctly scoped record still cannot borrow an identically named sibling sidecar.
  const conversation = path.join(f.root, "conversations/22222222-2222-2222-2222-222222222222");
  await mkdir(path.join(conversation, "artifacts/sources"), { recursive: true });
  await writeFile(path.join(conversation, source.path), source.raw);
  await writeFile(path.join(f.scoped, "notes/descriptor.md"), authored({ source: source.id }).raw);
  const unavailable = await vault.scan();
  expect(unavailable.records.length).toBe(0);
  expect(unavailable.issues.some((issue) => issue.code === "invalid-record")).toBeTruthy();
  await writeFile(path.join(f.scoped, source.path), source.raw);
  expect((await vault.scan()).records[0]!.valid).toBe(true);
});

it("guarded descriptor reads reject hard links, file symlinks and directory symlinks", async () => {
  const f = await fixture(),
    evidence = await original(f.scoped),
    { source } = await install(f.scoped, evidence);
  const target = path.join(f.scoped, source.path),
    outside = path.join(f.base, "descriptor.json");
  await writeFile(outside, source.raw);
  expect(readSourceDescriptor(f.scoped, source.path)).toBe(source.raw);
  // Each unsafe replacement has identical bytes: rejection must come from the guard.
  for (const kind of ["hard", "symbolic"]) {
    await rm(target);
    if (kind === "hard") {
      await link(outside, target);
    } else {
      await symlink(outside, target);
    }
    expect(() => readSourceDescriptor(f.scoped, source.path)).toThrow(/unsafe|symbolic|link/i);
    const data = await new SampleVault(f.scoped, f.access.scope).scan();
    expect(data.records.length).toBe(0);
    expect(data.issues.some((issue) => issue.code === "invalid-record")).toBeTruthy();
  }
  await rm(target);
  await rmdir(path.dirname(target));
  const elsewhere = path.join(f.base, "sources");
  await mkdir(elsewhere);
  await writeFile(path.join(elsewhere, source.id + ".json"), source.raw);
  await symlink(elsewhere, path.dirname(target));
  expect(() => readSourceDescriptor(f.scoped, source.path)).toThrow(/unsafe|symbolic|link/i);
  expect(() => readSourceDescriptor(f.scoped, "artifacts/sources/../../descriptor.json")).toThrow(
    /Invalid source descriptor path/,
  );
  expect(await readFile(outside, "utf8")).toBe(source.raw);
});

it("interrupted publication fences a reused descriptor and refuses completion without overwriting tampering", async () => {
  const f = await fixture(),
    evidence = await original(f.scoped),
    source = describeSource(evidence);
  const created = await f.writer.save(draft("Existing record", [evidence]), f.access, "agent");
  const record = await recordFor(f, created.id),
    originalRaw = await f.read(created.path);
  const input = edit(record, { body: "Proposed replacement body\n" });
  const interrupted = f.storage((stage: any) => {
    if (stage === "after-accept") {
      throw new Error("Intentional interruption");
    }
  });
  await expect(interrupted.save(input, f.access, "agent")).rejects.toThrow(
    /Intentional interruption/,
  );
  const plan = planFor(f, input.requestId);
  expect(plan.descriptors[source.path]).toBe(source.raw);
  expect(plan.changes.some((change: any) => change.path === "private/" + source.path)).toBe(false);
  const manifestBefore = await readFile(path.join(f.root, "vault.json"), "utf8");
  const tampered = source.raw.replace("Recorder original", "Recorder tampered");
  await writeFile(path.join(f.scoped, source.path), tampered);
  const resumed = f.storage().resume(f.access, input.requestId);
  expect(resumed.state).toBe("conflict");
  expect(
    await f.read(source.path),
    "the immutable-source conflict is never repaired by overwriting it",
  ).toBe(tampered);
  expect(
    await f.read(created.path),
    "replay rejects the dependency before installing the proposed record",
  ).toBe(originalRaw);
  expect(await readFile(path.join(f.root, "vault.json"), "utf8")).toBe(manifestBefore);
  expect(f.storage().resume(f.access, input.requestId)).toStrictEqual(resumed);
  await expect(f.writer.run(f.access, (vault: any) => vault.scan())).rejects.toThrow(
    /publication pending or conflicted/i,
  );
});
