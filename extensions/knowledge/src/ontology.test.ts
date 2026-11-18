import { cp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { listDirectoryTreeStrict } from "openclaw/plugin-sdk/file-access-runtime";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { stringify } from "yaml";
import { contract } from "./contract.js";
import { inspectOntology } from "./inspection.js";
import { parseOntology, resolveOntology, expandTypes, inferType } from "./ontology.js";
import { sampleVaultRoot } from "./plugin-files.js";
import { useTestTempDirs, defaultOrder } from "./test-support.js";
import { SampleVault, digest } from "./vault.js";

const tempDirs = useTestTempDirs();
const manifest = (name: any, definitions: any[] = [], extra = {}) => ({
  format: "knowledge-ontology-v1",
  name,
  version: "1.0.0",
  description: "Test ontology",
  definitions,
  ...extra,
});
const page = (name: any, extra = {}) => ({
  name,
  label: name,
  description: "Test page type",
  kind: "page",
  primitive: "entity",
  directory: `${name}/`,
  fields: [],
  ...extra,
});
const relation = (name: any, extra = {}) => ({
  name,
  label: name,
  description: "Test relationship",
  kind: "relationship",
  directory: "relationships/",
  fields: [],
  ...extra,
});
function resolve(...manifests: any[]) {
  const issues: any = [];
  const sources = manifests.map((m, i) =>
    parseOntology(
      i === manifests.length - 1 ? "ontology.yaml" : `ontologies/${m.name}.yaml`,
      stringify(m),
      issues,
    ),
  );
  return { ontology: resolveOntology(sources, issues), issues, sources };
}
async function fixture() {
  const root = tempDirs.make("knowledge-ontology-");
  await cp(sampleVaultRoot(), root, { recursive: true });
  await mkdir(path.join(root, "notes"), { recursive: true });

  return { root, vault: new SampleVault(root) };
}
async function hashes(root: any) {
  const out: Record<string, string> = {};
  for (const e of await listDirectoryTreeStrict(root)) {
    if (e.dirent.isFile()) {
      out[e.relativePath] = digest(await readFile(path.join(root, e.relativePath), "utf8"));
    }
  }
  return out;
}
const sourceWrite = (root: any, file: any, value: any) =>
  writeFile(path.join(root, file), stringify(value));

it("custom local extension participates in inspection, aliases, filing, fields, and endpoint validation without code changes", async () => {
  const { root, vault } = await fixture();
  const researcher = page("researcher", {
    directory: "researchers/",
    aliases: ["person"],
    fields: [
      {
        name: "specialty",
        label: "Specialty",
        type: "string",
        required: true,
        values: ["ecology", "history"],
      },
    ],
  });
  const advises = relation("advises", { from_types: ["researcher"], to_types: ["project"] });
  await sourceWrite(
    root,
    "ontology.yaml",
    manifest("research", [researcher, advises], { extends: "knowledge-default" }),
  );
  await mkdir(path.join(root, "researchers"));
  const original = await readFile(path.join(root, "people/alex-rivera.md"), "utf8");
  const record = original
    .replace("sample_person_alex", "sample_researcher_one")
    .replace("type: person", "type: researcher")
    .replace("fields:\n", "fields:\n  specialty: ecology\n");
  await writeFile(path.join(root, "researchers/researcher.md"), record);
  const edge = (await readFile(path.join(root, "relationships/alex-leads-garden.md"), "utf8"))
    .replaceAll("sample_person_alex", "sample_researcher_one")
    .replace("sample_rel_leads", "sample_rel_advises")
    .replace("label: leads", "label: advises");
  await writeFile(path.join(root, "relationships/advises.md"), edge);
  const before = await hashes(root),
    data = await vault.scan(),
    report = await vault.inspectOntology();
  expect(data.issues).toStrictEqual([]);
  expect(report.available).toBe(true);
  expect(Check(contract.operations.ontology.output, await inspectOntology(vault, {}))).toBe(true);
  const custom = report.definitions.find((d) => d.name === "researcher");
  expect(custom!.source).toBe("ontology.yaml");
  expect(custom!.affectedRecords.length).toBe(1);
  expect(custom!.description).toBe(researcher.description);
  expect(custom!.fields).toStrictEqual(researcher.fields);
  expect(report.definitions.find((d) => d.name === "advises")!.fromTypes).toStrictEqual([
    "researcher",
  ]);
  expect(report.definitions.find((d) => d.name === "advises")!.toTypes).toStrictEqual(["project"]);
  expect(JSON.parse(custom!.effective).behaviors.extractable).toBe(false);
  expect((await vault.list({ type: "person" })).total).toBe(2);
  expect((await vault.list({ type: "researcher" })).total).toBe(2); // symmetric, not subtyping
  expect((await vault.list({ type: "organization" })).records[0]!.type).toBe("company");
  expect((await vault.list({ type: "advises" })).total).toBe(1);
  expect(await hashes(root)).toStrictEqual(before);
  for (const [from, to, code] of [
    ["specialty: ecology", "specialty: 42", "field-type"],
    ["  specialty: ecology\n", "", "required-field"],
    ["specialty: ecology", "specialty: music", "field-type"],
  ]) {
    await writeFile(path.join(root, "researchers/researcher.md"), record.replace(from!, to!));
    expect((await vault.scan()).issues.some((i) => i.code === code)).toBeTruthy();
  }
  await writeFile(path.join(root, "researchers/researcher.md"), record);
  await writeFile(
    path.join(root, "relationships/advises.md"),
    edge.replace("from: sample_researcher_one", "from: sample_person_alex"),
  );
  expect(
    (await vault.scan()).issues.some(
      (i) => i.path === "relationships/advises.md" && i.code === "endpoint-type",
    ),
  ).toBeTruthy(); // aliases don't loosen validation
  await writeFile(
    path.join(root, "notes/misfiled.md"),
    record.replace("sample_researcher_one", "sample_researcher_two"),
  );
  expect(
    (await vault.scan()).issues.some((i) => i.path === "notes/misfiled.md" && i.code === "filing"),
  ).toBeTruthy();
});

it("default source type exposes optional canonical and snapshot provenance fields", async () => {
  const { vault } = await fixture();
  const report = await vault.inspectOntology();
  const source = report.definitions.find((definition) => definition.name === "source");
  expect(source!.fields.map((field) => field.name)).toStrictEqual([
    "source_role",
    "provider",
    "source_key",
    "coverage_start",
    "coverage_end",
    "observed_at",
    "source_revision",
    "manifest_sha256",
    "item_count",
    "completeness",
    "watermark",
  ]);
  expect(source!.fields.find((field) => field.name === "source_role")!.values).toStrictEqual([
    "canonical",
    "snapshot",
  ]);
  expect(source!.fields.find((field) => field.name === "completeness")!.values).toStrictEqual([
    "complete",
    "partial",
    "unknown",
  ]);
  expect(source!.fields.every((field) => field.required === false)).toBeTruthy();
});

it("whole-definition overrides, nearest-first path precedence, and root positions match gbrain composition", () => {
  const base = manifest("base", [
    page("person", {
      directory: "people/",
      behaviors: { extractable: true, expert_routing: true },
      fields: [{ name: "role", label: "Role", type: "string", required: true }],
    }),
    page("note", { primitive: "concept", directory: "notes/" }),
  ]);
  const parent = manifest(
    "parent",
    [page("researcher", { directory: "notes/" }), page("person", { directory: "persons/" })],
    { extends: "base" },
  );
  const leaf = manifest(
    "leaf",
    [page("thesis", { directory: "notes/" }), page("person", { directory: "people/" })],
    { extends: "parent" },
  );
  const { ontology: o, issues } = resolve(base, parent, leaf);
  expect(issues).toStrictEqual([]);
  expect(o!.definitions.map((d) => d.definition.name)).toStrictEqual([
    "thesis",
    "researcher",
    "person",
    "note",
  ]);
  expect(inferType(o, "notes/a.md")).toBe("thesis");
  const person = o!.definitions.find((d) => d.definition.name === "person");
  expect(person!.definition.fields).toStrictEqual([]);
  expect(person!.definition.behaviors!.expert_routing).toBe(false);
  expect(person!.ontology).toBe("leaf");
});

it("selective borrowing is child-local, whole-definition, below child and above parents", () => {
  const base = manifest("base", [page("person"), page("note", { primitive: "concept" })]);
  const donor = manifest(
    "donor",
    [page("person", { directory: "borrowed/" }), page("scientist"), relation("mentors")],
    { extends: "base" },
  );
  const borrow = [
    { ontology: "donor", types: ["scientist", "person"], relationships: ["mentors"] },
  ];
  const borrowed = resolve(
    base,
    donor,
    manifest("leaf", [], { extends: "base", borrow_from: borrow }),
  );
  const issues = borrowed.issues;
  let o = borrowed.ontology;
  expect(issues).toStrictEqual([]);
  expect(o!.definitions.find((d) => d.definition.name === "person")!.ontology).toBe("donor");
  expect(o!.definitions.some((d) => d.definition.name === "mentors")).toBeTruthy();
  o = resolve(
    base,
    donor,
    manifest("leaf", [page("person")], { extends: "base", borrow_from: borrow }),
  ).ontology;
  expect(o!.definitions.find((d) => d.definition.name === "person")!.ontology).toBe("leaf");
  expect(
    resolve(
      base,
      donor,
      manifest("leaf", [], {
        extends: "base",
        borrow_from: [{ ontology: "donor", types: ["note"] }],
      }),
    ).ontology,
  ).toBe(null);
  const parent = manifest("parent", [], { extends: "base", borrow_from: borrow });
  o = resolve(base, donor, parent, manifest("leaf", [], { extends: "parent" })).ontology;
  expect(o!.definitions.some((d) => d.definition.name === "scientist")).toBe(false);
  o = resolve(donor, manifest("standalone", [page("person")], { borrow_from: borrow })).ontology;
  expect(o!.definitions.find((d) => d.definition.name === "person")!.ontology).toBe("standalone");
});

it("alias closure is transitive and cyclic-safe, not primitive subtyping", () => {
  const { ontology: o } = resolve(
    manifest("leaf", [
      page("person", { aliases: ["researcher"] }),
      page("researcher", { aliases: ["scientist"] }),
      page("scientist", { aliases: ["person"] }),
      page("company"),
    ]),
  );
  expect([...expandTypes(o, "scientist")].toSorted(defaultOrder)).toStrictEqual([
    "person",
    "researcher",
    "scientist",
  ]);
  expect([...expandTypes(o, "company")]).toStrictEqual(["company"]);
});

it("effective fingerprint changes for inherited/borrowed edits, not YAML key order or comments", async () => {
  const { root, vault } = await fixture();
  await mkdir(path.join(root, "ontologies"));
  const parent = manifest("parent", [page("researcher")], { extends: "knowledge-default" });
  await sourceWrite(root, "ontologies/parent.yaml", parent);
  await sourceWrite(root, "ontology.yaml", manifest("local", [], { extends: "parent" }));
  const first = (await vault.scan()).ontology!.fingerprint;
  parent.definitions[0]!.fields = [{ name: "role", label: "Role", type: "string" }];
  await sourceWrite(root, "ontologies/parent.yaml", parent);
  const second = (await vault.scan()).ontology!.fingerprint;
  expect(first).not.toBe(second);
  await writeFile(
    path.join(root, "ontologies/parent.yaml"),
    "# comment\n" + stringify(Object.fromEntries(Object.entries(parent).toReversed())),
  );
  expect((await vault.scan()).ontology!.fingerprint).toBe(second);
  await sourceWrite(
    root,
    "ontology.yaml",
    manifest("local", [], {
      extends: "knowledge-default",
      borrow_from: [{ ontology: "parent", types: ["researcher"] }],
    }),
  );
  const third = (await vault.scan()).ontology!.fingerprint;
  parent.definitions[0]!.directory = "changed/";
  await sourceWrite(root, "ontologies/parent.yaml", parent);
  expect((await vault.scan()).ontology!.fingerprint).not.toBe(third);
});

it("invalid active ontology is inspectable, blocks dependent validation, and never changes files", async () => {
  const { root, vault } = await fixture();
  for (const raw of [
    "format: [invalid\n",
    stringify(manifest("local", [], { extends: "missing" })),
    stringify(manifest("local", [], { phases: ["extract_atoms"] })),
    stringify(manifest("local", [relation("bad", { from_types: ["missing"] })])),
  ]) {
    await writeFile(path.join(root, "ontology.yaml"), raw);
    const before = await hashes(root);
    const data = await vault.scan(),
      report = await vault.inspectOntology();
    expect(data.ontology).toBe(null);
    expect(report.available).toBe(false);
    expect(report.definitions.length).toBe(0);
    expect(report.affectedRecords.length).toBe(6);
    expect(report.issues.some((i) => i.code === "ontology-unavailable")).toBeTruthy();
    expect(report.sources.find((s) => s.path === "ontology.yaml")!.raw).toBe(raw);
    expect(Check(contract.operations.ontology.output, await inspectOntology(vault, {}))).toBe(true);
    expect(await hashes(root)).toStrictEqual(before);
    expect((await vault.detail("sample_person_alex")).record).toBeTruthy();
  }
});

it("cycles, missing parents, duplicate identities, cross-kind overrides and depth overflow fail closed", () => {
  expect(
    resolve(manifest("a", [], { extends: "b" }), manifest("b", [], { extends: "a" })).ontology,
  ).toBe(null);
  expect(resolve(manifest("a", [], { extends: "missing" })).ontology).toBe(null);
  expect(resolve(manifest("same"), manifest("same")).ontology).toBe(null);
  expect(
    resolve(
      manifest("base", [page("person")]),
      manifest("child", [relation("person")], { extends: "base" }),
    ).ontology,
  ).toBe(null);
  const chain = Array.from({ length: 9 }, (_, i) =>
    manifest(`layer-${i}`, [], i ? { extends: `layer-${i - 1}` } : {}),
  );
  expect(resolve(...chain).ontology).toBe(null);
  expect(resolve(...chain.slice(0, 8)).ontology).not.toBe(null);
});

it("invalid primitives, fields, duplicate definitions and unsupported features are rejected before activation", () => {
  for (const d of [
    page("x", { primitive: "unknown" }),
    page("x", { from_types: ["person"] }),
    relation("x", { aliases: ["y"] }),
    page("x", { fields: [{ name: "x", label: "x", type: "number", values: ["1"] }] }),
    page("x", { fields: [{ name: "x", label: "x", type: "string", values: [] }] }),
  ]) {
    expect(resolve(manifest("local", [d])).ontology).toBe(null);
  }
  expect(resolve(manifest("local", [page("x"), page("x")])).ontology).toBe(null);
  expect(
    resolve(manifest("local", [], { remote: "https://example.org/ontology.yaml" })).ontology,
  ).toBe(null);
});

it("path inference never overwrites explicit type or original metadata", async () => {
  const { root, vault } = await fixture();
  const file = path.join(root, "people/alex-rivera.md"),
    raw = await readFile(file, "utf8");
  await writeFile(file, raw.replace("type: person\n", ""));
  let r = await vault.detail("sample_person_alex");
  expect(r.record!.type).toBe("person");
  expect(JSON.parse(r.record!.metadata).type).toBe(undefined);
  await writeFile(file, raw.replace("type: person", "type: note"));
  r = await vault.detail("sample_person_alex");
  expect(r.record!.type).toBe("note");
  expect(r.issues.some((i) => i.code === "filing")).toBeTruthy();
});

it("unsafe or directory active ontology cannot silently fall back; legacy schemas are explicitly rejected", async () => {
  const { root, vault } = await fixture();
  await mkdir(path.join(root, "ontology.yaml"));
  expect((await vault.scan()).ontology, "a directory is invalid, not an absent selection").toBe(
    null,
  );
  await rm(path.join(root, "ontology.yaml"), { recursive: true });
  await symlink("/etc/passwd", path.join(root, "ontology.yaml"));
  expect((await vault.scan()).ontology).toBe(null);
  await cp(
    new URL("../test-fixtures/legacy-schemas/", import.meta.url),
    path.join(root, "schemas"),
    { recursive: true },
  );
  expect((await vault.scan()).issues.some((i) => i.code === "unsupported-schema")).toBeTruthy();
});

it("unrestricted relationships still require endpoints with declared page types", async () => {
  const { root, vault } = await fixture();
  const person = path.join(root, "people/alex-rivera.md");
  await writeFile(
    person,
    (await readFile(person, "utf8")).replace("type: person", "type: unknown"),
  );
  const edge = path.join(root, "relationships/alex-leads-garden.md");
  await writeFile(
    edge,
    (await readFile(edge, "utf8")).replace("label: leads", "label: relates_to"),
  );
  expect(
    (await vault.scan()).issues.some(
      (i) => i.path === "relationships/alex-leads-garden.md" && i.code === "endpoint-type",
    ),
  ).toBeTruthy();
});

it("valid compact manifests remain inspectable after effective-definition formatting", async () => {
  const { root, vault } = await fixture();
  const fields = Array.from({ length: 50 }, (_, i) => ({
    name: `field_${i}`,
    label: "Field",
    type: "string",
    values: Array(100).fill("x"),
  }));
  const raw = JSON.stringify(
    manifest("local", [page("dense", { fields })], { extends: "knowledge-default" }),
  );
  expect(Buffer.byteLength(raw) < 65536).toBeTruthy();
  await writeFile(path.join(root, "ontology.yaml"), raw);
  const report = await vault.inspectOntology();
  expect(report.available).toBe(true);
  expect(Check(contract.operations.ontology.output, await inspectOntology(vault, {}))).toBe(true);
});
