import { cp, mkdir, readFile, writeFile, rename, symlink } from "node:fs/promises";
import path from "node:path";
import { listDirectoryTreeStrict } from "openclaw/plugin-sdk/file-access-runtime";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import { inspectRecord, inspectOntology } from "./inspection.js";
import { sampleVaultRoot } from "./plugin-files.js";
import { useTestTempDirs } from "./test-support.js";
import { SampleVault, digest } from "./vault.js";

const tempDirs = useTestTempDirs();
async function fixture() {
  const root = tempDirs.make("knowledge-test-");
  await cp(sampleVaultRoot(), root, { recursive: true });
  await mkdir(path.join(root, "notes"), { recursive: true });

  return { root, vault: new SampleVault(root) };
}
async function hashes(root: any) {
  const found: Record<string, string> = {};
  for (const entry of await listDirectoryTreeStrict(root)) {
    if (entry.dirent.isFile()) {
      found[entry.relativePath] = digest(
        await readFile(path.join(root, entry.relativePath), "utf8"),
      );
    }
  }
  return found;
}
it("representative vault: records, ontology, diagnostics, citations, and zero writes", async () => {
  const before = await hashes(sampleVaultRoot()),
    vault = new SampleVault(),
    data = await vault.scan();
  expect(data.records.length).toBe(7);
  expect(data.records.filter((r) => r.valid).length).toBe(7);
  expect(data.ontology!.definitions.length).toBe(38);
  expect(Check(contract.operations.ontology.output, await inspectOntology(vault, {}))).toBe(true);
  expect(data.issues).toStrictEqual([]);
  const result = await vault.detail("sample_claim_pilot");
  expect(result.evidence[0]!.verified).toBe(true);
  expect(result.evidence[0]!.excerpt).toMatch(/small pilot garden/);
  expect(result.references.some((r) => r.id === "sample_person_alex")).toBeTruthy();
  const inspected = await inspectRecord(vault, { id: "sample_claim_pilot" });
  expect(Check(contract.operations.record.output, inspected)).toBe(true);
  expect(await hashes(sampleVaultRoot())).toStrictEqual(before);
});
it.each(["München", "Mu\u0308nchen"])("lists canonical %s titles", async (title) => {
  const { root, vault } = await fixture();
  const person = path.join(root, "people/alex-rivera.md");
  await writeFile(
    person,
    (await readFile(person, "utf8")).replace("title: Alex Rivera", `title: ${title}`),
  );
  const query = title.normalize(title === title.normalize("NFC") ? "NFD" : "NFC");
  const records = (await vault.list({ query })).records;
  expect(records).toMatchObject([{ id: "sample_person_alex", title }]);
  let offset: number | null = 0;
  const rows = [];
  do {
    const result = await vault.list({ offset, limit: 3 });
    expect(Check(contract.operations.records.output, result)).toBeTruthy();
    rows.push(...result.records);
    offset = result.nextOffset;
  } while (offset !== null);
  expect(rows.length).toBe(7);
  expect(new Set(rows.map((r) => r.path)).size).toBe(7);
  const aliases = (await vault.list({ query: "Garden pilot" })).records.map((r) => r.id);
  expect(aliases).toContain("sample_project_garden");
  expect((await vault.list({ kind: "claim" })).total).toBe(1);
  expect((await vault.list({ query: "not here" })).total).toBe(0);
  expect(Check(contract.operations.records.input, { limit: 101 })).toBe(false);
  expect(Check(contract.operations.records.input, { root: "/etc" })).toBe(false);
});
it("rename preserves identity and metadata; duplicate IDs never pick a winner", async () => {
  const { root, vault } = await fixture();
  const before = await vault.detail("sample_person_alex");
  await rename(path.join(root, "people/alex-rivera.md"), path.join(root, "people/renamed.md"));
  const after = await vault.detail("sample_person_alex");
  expect(after.record!.hash).toBe(before.record!.hash);
  expect(after.record!.path).toBe("people/renamed.md");
  expect(JSON.parse(after.record!.metadata).custom_note).toBe(
    "Unknown user metadata is preserved.",
  );
  await cp(new URL("../test-fixtures/invalid-vault/", import.meta.url), root, { recursive: true });
  const hashesBefore = await hashes(root),
    data = await vault.scan();
  expect(new Set(data.issues.map((i) => i.code))).toStrictEqual(
    new Set(["invalid-record", "ontology-unavailable", "broken-reference", "duplicate-id"]),
  );
  expect(data.records.length).toBe(11);
  expect(await hashes(root)).toStrictEqual(hashesBefore);
  expect((await vault.detail("sample_duplicate_id")).record).toBe(null);
  expect((await vault.detail("missing-id")).record).toBe(null);
});
it("changed source invalidates evidence without serving unverified content", async () => {
  const { root, vault } = await fixture();
  await writeFile(path.join(root, "artifacts/planning-meeting.txt"), "Changed source\n");
  const result = await vault.detail("sample_claim_pilot");
  expect(result.record!.valid).toBe(false);
  expect(result.evidence[0]!.verified).toBe(false);
  expect(result.evidence[0]!.excerpt).toBe("");
  expect(result.issues.some((i) => i.code === "invalid-evidence")).toBeTruthy();
});
it("file symlinks and path traversal are not followed", async () => {
  const { root, vault } = await fixture();
  await symlink("/etc/passwd", path.join(root, "notes/secret.md"));
  const file = path.join(root, "claims/pilot-decision.md");
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace(
      "artifacts/planning-meeting.txt",
      "artifacts/../../private.txt",
    ),
  );
  const data = await vault.scan();
  expect(data.issues.some((i) => i.code === "unsafe-path")).toBeTruthy();
  expect(data.issues.some((i) => i.code === "invalid-evidence")).toBeTruthy();
  expect(data.records.some((r) => r.path === "notes/secret.md")).toBe(false);
});
it("duplicate keys, unknown scope, YAML alias expansion and oversize records are diagnosed", async () => {
  const { root, vault } = await fixture();
  const original = await readFile(path.join(root, "people/alex-rivera.md"), "utf8");
  const writeNote = (name: string, content: string) =>
    writeFile(path.join(root, "notes", `${name}.md`), content);
  await writeNote("duplicate-key", original.replace("revision: 1", "revision: 1\nrevision: 2"));
  await writeNote(
    "unknown-scope",
    original.replace("visibility: sample", "visibility: agent-private"),
  );
  await writeNote(
    "alias",
    original.replace(
      "custom_note: Unknown user metadata is preserved.",
      "custom_note: &x [1, 2]\nextra: *x",
    ),
  );
  await writeNote("large", "x".repeat(65537));
  const data = await vault.scan();
  for (const file of ["duplicate-key", "unknown-scope", "alias", "large"]) {
    expect(
      data.issues.some((i) => i.path === `notes/${file}.md` && i.code === "invalid-record"),
      file,
    ).toBeTruthy();
  }
});
it("total partition size does not cap a scan; every record is cataloged", async () => {
  const { root, vault } = await fixture();
  const original = await readFile(path.join(root, "people/alex-rivera.md"), "utf8");
  const before = (await vault.scan()).records.length;
  // ~8.5 MB: past the retired 8 MiB whole-scan budget; each file stays under 64 KiB.
  for (let i = 0; i < 135; i++) {
    await writeFile(
      path.join(root, `notes/budget-${i}.md`),
      original.replace("sample_person_alex", `sample_budget_${i}`) + "x".repeat(63000),
    );
  }
  const data = await vault.scan();
  expect(data.records.length).toBe(before + 135);
  expect(data.records.filter((r) => r.path.startsWith("notes/budget-") && !r.valid).length).toBe(0);
});
