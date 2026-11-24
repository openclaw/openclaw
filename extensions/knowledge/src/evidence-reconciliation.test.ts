import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { parse } from "yaml";
import {
  ReconcileEvidenceOutput,
  type ReconcileEvidenceInput,
} from "./evidence-reconciliation-contract.js";
import { GitHistory, GitUnavailable } from "./git-history.js";
import { SqliteIdentityStore } from "./identity-store.js";
import { KnowledgeStorage } from "./storage.js";
import { createVault, plainAccess, useTestTempDirs, jsonRoundTrip } from "./test-support.js";
import { digest } from "./vault.js";

const tempDirs = useTestTempDirs();

class NoGit extends GitHistory {
  override checkpoint(): never {
    throw new GitUnavailable("Disabled in migration fixture");
  }
}
const meta = (raw: any) => parse(/^---\n([\s\S]*?)\n---\n/.exec(raw)![1]!);

async function fixture() {
  const base = tempDirs.make("knowledge-source-migration-");

  const f = await createVault(base),
    db = new SqliteIdentityStore(f.config.statePath);
  const storage = new KnowledgeStorage(f.config, db, undefined, new NoGit(f.root)),
    access = plainAccess();
  const scoped = path.join(f.root, "private");
  const scan = () => storage.run(access, (vault) => vault.scan());
  const record = async (id: any) => (await scan()).records.find((r) => r.id === id);
  const input = async (
    id: any,
    extra: Partial<ReconcileEvidenceInput> = {},
  ): Promise<ReconcileEvidenceInput> => {
    const current = await record(id),
      data = await scan();
    return {
      requestId: randomUUID(),
      id,
      expectedVaultId: f.config.vaultId,
      expectedRevision: current!.revision,
      expectedHash: current!.hash,
      expectedOntologyFingerprint: data.ontology!.fingerprint,
      reason: "Explicit fixture representation review",
      dryRun: true,
      representation: "compact",
      ...extra,
    };
  };
  // Accepted mutation journal rows; rejected reconciliations must not add one.
  const mutations = () =>
    db.withDatabase((d) => d.prepare("SELECT count(*) AS n FROM mutations").get()!.n);
  return { ...f, db, storage, access, scoped, scan, record, input, mutations };
}

async function retained(
  f: any,
  name: any,
  text = "line one\nline two\n",
  attribution = "Retained original",
) {
  const evidence = { path: "artifacts/" + name + ".txt", sha256: digest(text), attribution };
  await mkdir(path.join(f.scoped, "artifacts"), { recursive: true });
  await writeFile(path.join(f.scoped, evidence.path), text);
  return evidence;
}
const save = (f: any, attachments: any, extra = {}) =>
  f.storage.save(
    {
      requestId: randomUUID(),
      title: "Person fixture",
      type: "person",
      body: "# State\r\nSupported state.\r\n# Timeline\r\nHistorical context.\r\n",
      attachments,
      ...extra,
    },
    f.access,
    "agent",
  );

// Omit only representation identity and mutation bookkeeping for semantic equality.
function semantic(metadata: any) {
  const value = jsonRoundTrip(metadata);
  for (const key of ["revision", "updated_at", "evidence_change"]) {
    delete value[key];
  }
  const visit = (obj: any) => {
    if (!obj || typeof obj !== "object") {
      return;
    }
    if (obj.path && obj.sha256) {
      delete obj.source;
    }
    Object.values(obj).forEach(visit);
  };
  visit(value);
  return value;
}

it("preview is read-only; expanded and compact migrations preserve semantics, authorship, originals and history", async () => {
  const f = await fixture(),
    evidence = await retained(f, "source");
  const saved = await save(f, [evidence]),
    before = await f.record(saved.id);
  const originals = await readFile(path.join(f.scoped, evidence.path));
  const descriptorsBefore = await readdir(path.join(f.scoped, "artifacts/sources"));
  const historyBefore = f.storage.history(f.access, { id: saved.id }).entries;
  const previewInput = await f.input(saved.id, { representation: "expanded" });
  const preview = await f.storage.reconcileEvidence(previewInput, f.access);
  expect(Check(ReconcileEvidenceOutput, preview)).toBeTruthy();
  expect(preview.state).toBe("preview");
  expect((await f.record(saved.id))!.hash).toBe(before!.hash);
  expect(f.storage.history(f.access, { id: saved.id }).entries.length).toBe(historyBefore.length);
  expect(await readdir(path.join(f.scoped, "artifacts/sources"))).toStrictEqual(descriptorsBefore);
  const apply = { ...previewInput, dryRun: false },
    expanded = await f.storage.reconcileEvidence(apply, f.access);
  expect(expanded.state).toBe("published");
  expect(Check(ReconcileEvidenceOutput, expanded)).toBeTruthy();
  expect(await f.storage.reconcileEvidence(apply, f.access)).toStrictEqual(expanded);
  const full = await f.record(saved.id);
  expect(meta(full!.raw).evidence[0].path).toBeTruthy();
  expect(full!.body).toBe(before!.body);
  expect(semantic(full!.metadata)).toStrictEqual(semantic(before!.metadata));
  expect(full!.writtenByAgentId, "representation conversion is not a new author").toBe("main");
  const compact = await f.storage.reconcileEvidence(
    await f.input(saved.id, { dryRun: false }),
    f.access,
  );
  expect(compact.revision).toBe(before!.revision + 2);
  const after = await f.record(saved.id);
  expect(meta(after!.raw).evidence[0].path).toBe(undefined);
  expect(semantic(after!.metadata)).toStrictEqual(semantic(before!.metadata));
  expect(after!.body).toBe(before!.body);
  expect(await readFile(path.join(f.scoped, evidence.path))).toStrictEqual(originals);
  expect(await readdir(path.join(f.scoped, "artifacts/sources"))).toStrictEqual(descriptorsBefore);
  const history = f.storage.history(f.access, { id: saved.id }).entries;
  expect(history.slice(0, 2).map((e) => e.provenance)).toStrictEqual(["conversion", "conversion"]);
  expect(f.storage.revision(f.access, history.at(-1)!.sequence).raw).toBe(before!.raw);
});

it("reviewed current set replacement retains annotation support, other records, raw history and source files", async () => {
  const f = await fixture(),
    a = await retained(f, "a"),
    b = await retained(f, "b");
  const confidence = { level: "medium", basis: "Explicitly supported annotation", evidence: [a] };
  const saved = await save(f, [a, b], { attribution_confidence: confidence });
  const other = await save(f, [b], { title: "Other person" }),
    otherBefore = await f.record(other.id);
  const before = await f.record(saved.id),
    sourcePaths = [a.path, b.path];
  const receipt = await f.storage.reconcileEvidence(
    await f.input(saved.id, { evidence: [], dryRun: false }),
    f.access,
  );
  const after = await f.record(saved.id);
  expect(receipt.state).toBe("published");
  expect(after!.body).toBe(before!.body);
  expect(after!.metadata.evidence!.length).toBe(1);
  expect(after!.metadata.evidence![0]!.path).toBe(a.path);
  expect(after!.metadata.attribution_confidence).toStrictEqual(
    before!.metadata.attribution_confidence,
  );
  expect((await f.record(other.id))!.hash).toBe(otherBefore!.hash);
  for (const p of sourcePaths) {
    expect((await readFile(path.join(f.scoped, p))).length).toBeTruthy();
  }
  const old = f.storage.history(f.access, { id: saved.id }).entries.at(-1);
  expect(f.storage.revision(f.access, old!.sequence).raw).toBe(before!.raw);
});

it("stale revision/hash, ontology/vault and scope fences reject before mutation", async () => {
  const f = await fixture(),
    saved = await save(f, [await retained(f, "source")]);
  const input = await f.input(saved.id, { dryRun: false }),
    before = await f.record(saved.id);
  for (const change of [
    { expectedRevision: 99 },
    { expectedHash: "0".repeat(64) },
    { expectedOntologyFingerprint: "0".repeat(64) },
    { expectedVaultId: randomUUID() },
  ]) {
    await expect(f.storage.reconcileEvidence({ ...input, ...change }, f.access)).rejects.toThrow(
      /changed|conflict/i,
    );
  }
  await expect(
    f.storage.reconcileEvidence(
      input,
      plainAccess({ visibility: "conversation", sessionId: randomUUID() }),
    ),
  ).rejects.toThrow(/unavailable|scope/i);
  expect((await f.record(saved.id))!.hash).toBe(before!.hash);
  expect(f.mutations()).toBe(1);
});

it("expanded dry run refuses an oversized rollback without discarding compact support", async () => {
  const f = await fixture(),
    evidence = await retained(f, "large", "line\n".repeat(120), "A".repeat(1000));
  const citations = Array.from({ length: 100 }, (_, n) => ({
    ...evidence,
    start_line: n + 1,
    end_line: n + 1,
  }));
  const saved = await save(f, citations),
    initial = await f.record(saved.id);
  // Compact associations fit; expanding them crosses the durable byte ceiling.
  const prefix = initial!.raw.slice(0, initial!.raw.length - initial!.body.length);
  await writeFile(
    path.join(f.scoped, initial!.path),
    prefix + "x".repeat(4_960_000 - Buffer.byteLength(prefix)),
  );
  const before = await f.record(saved.id);
  await expect(
    f.storage.reconcileEvidence(await f.input(saved.id, { representation: "expanded" }), f.access),
  ).rejects.toThrow(/exceeds record limits/);
  expect((await f.record(saved.id))!.hash).toBe(before!.hash);
  expect(before!.metadata.evidence!.length).toBe(100);
});

// A preparation dependency must not become a silently recreated immutable file.
it("deleting a reused descriptor before acceptance rejects without publication", async () => {
  const f = await fixture(),
    saved = await save(f, [await retained(f, "race")]);
  const before = await f.record(saved.id),
    input = await f.input(saved.id, { dryRun: false });
  const descriptor = path.join(
    f.scoped,
    "artifacts/sources",
    before!.metadata.evidence![0]!.source + ".json",
  );
  const { unlinkSync } = await import("node:fs");
  const writer = new KnowledgeStorage(
    f.config,
    f.db,
    (stage) => {
      if (stage === "before-accept") {
        unlinkSync(descriptor);
      }
    },
    new NoGit(f.root),
  );
  await expect(writer.reconcileEvidence(input, f.access)).rejects.toThrow(
    /ENOENT|missing|unavailable/i,
  );
  expect(await readFile(path.join(f.scoped, before!.path), "utf8")).toBe(before!.raw);
  await expect(readFile(descriptor)).rejects.toThrow(/ENOENT/);
  expect(f.mutations()).toBe(1);
});
