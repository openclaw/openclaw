import { cp, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { FeatureClient } from "openclaw/plugin-sdk/feature-contract";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import { loadVocabulary } from "./inspection-client.js";
import { inspectRecord, inspectOntology, RECORD_RESPONSE_BYTES } from "./inspection.js";
import { sampleVaultRoot } from "./plugin-files.js";
import { useTestTempDirs, jsonRoundTrip } from "./test-support.js";
import { SampleVault } from "./vault.js";

const tempDirs = useTestTempDirs();

// inspectRecord reads only detail(); these fakes stand in for a scanned vault.
const detailVault = (
  detail: (id: string, evidenceOffset: number, evidenceLimit: number) => Promise<unknown>,
) => ({ detail }) as SampleVault;

const checked = (operation: keyof typeof contract.operations, result: any) => {
  expect(
    Check(contract.operations[operation].output, result),
    JSON.stringify(result).slice(0, 300),
  ).toBeTruthy();
  return result;
};
async function fixture() {
  const root = tempDirs.make("knowledge-inspection-");

  await cp(sampleVaultRoot(), root, { recursive: true });
  return { root, vault: new SampleVault(root) };
}

it("record defaults return content once and compact metadata without evidence", async () => {
  const vault = new SampleVault(),
    result = checked("record", await inspectRecord(vault, { id: "sample_claim_pilot" }));
  expect(result.record.body).toBeTruthy();
  expect(result.record.raw).toBe(undefined);
  expect(result.record.metadata).toBeTruthy();
  expect(result.record.metadata.evidence).toBe(undefined);
  expect(result.references).toBe(undefined);
  expect(result.record.attribution).toBeTruthy();
  expect(result.record.assertionOrigin).toBeTruthy();
  expect(result.evidence).toBe(undefined);
  expect(result.content.nextOffset).toBe(null);
  for (const id of ["missing-id", "sample_duplicate_id"]) {
    expect(checked("record", await inspectRecord(vault, { id })).record).toBe(null);
  }
});

it("record text and raw pages reassemble the exact observed content within the byte limit", async () => {
  const { root, vault } = await fixture(),
    file = path.join(root, "people/alex-rivera.md");
  // Long prose crosses the character limit; escaped Unicode crosses the JSON byte limit.
  const appended = "A long paragraph. ".repeat(1800) + '🦞"\\\n'.repeat(9000);
  await writeFile(file, (await readFile(file, "utf8")) + "\n" + appended);
  const original = (await vault.detail("sample_person_alex")).record!;
  const pages = async (input: object) => {
    const result = [];
    let offset = 0;
    do {
      const page = checked(
        "record",
        await inspectRecord(vault, { id: "sample_person_alex", ...input, offset }),
      );
      expect(Buffer.byteLength(JSON.stringify(page)) <= RECORD_RESPONSE_BYTES).toBeTruthy();
      expect(page.content.nextOffset === null || page.content.nextOffset > offset).toBeTruthy();
      expect(page.record.hash).toBe(original.hash);
      result.push(page);
      offset = page.content.nextOffset;
    } while (offset !== null);
    return result;
  };
  const body = await pages({ maxChars: 4000 });
  expect(body.every((page) => page.record.body.length <= 4000)).toBeTruthy();
  expect(body.map((page) => page.record.body).join("")).toBe(original.body);
  const raw = await pages({ view: "raw", metadataView: "none", maxChars: 65536 });
  expect(raw.every((page) => page.record.body === undefined && !page.evidence)).toBeTruthy();
  expect(raw.map((page) => page.record.raw).join("")).toBe(original.raw);
  const summary = checked(
    "record",
    await inspectRecord(vault, {
      id: "sample_person_alex",
      view: "summary",
      includeMetadata: true,
    }),
  );
  expect(summary.record.body).toBe(undefined);
  expect(summary.record.metadata.custom_note).toBe("Unknown user metadata is preserved.");
  const beyond = checked(
    "record",
    await inspectRecord(vault, { id: "sample_person_alex", offset: 999999 }),
  );
  expect(beyond.record.body).toBe("");
  expect(beyond.content.nextOffset).toBe(null);
});

it("evidence budgets disclose truncation; references are paginated separately", async () => {
  const vault = new SampleVault();
  const small = checked(
    "record",
    await inspectRecord(vault, {
      id: "sample_claim_pilot",
      includeEvidence: true,
      maxEvidenceChars: 8,
      includeReferences: true,
      referenceLimit: 1,
    }),
  );
  expect(small.evidence[0].excerpt.length).toBe(8);
  expect(small.evidence[0].excerptTruncated).toBe(true);
  expect(small.evidence[0].verified).toBe(true);
  expect(small.references.length).toBe(1);
  const refs = [...small.references];
  let offset = small.nextReferenceOffset;
  while (offset !== null) {
    const r = checked(
      "record",
      await inspectRecord(vault, {
        id: "sample_claim_pilot",
        view: "summary",
        includeReferences: true,
        referenceLimit: 1,
        referenceOffset: offset,
      }),
    );
    refs.push(...r.references);
    offset = r.nextReferenceOffset;
  }
  expect(refs.length).toBe(small.referenceTotal);
  expect(new Set(refs.map((r) => r.path)).size).toBe(refs.length);
});

it("ontology catalog is concise; definition detail is structured and filtered", async () => {
  const vault = new SampleVault(),
    result = checked("ontology", await inspectOntology(vault, {}));
  expect(result.total).toBe(38);
  expect(result.definitions.length).toBe(38);
  expect(result.sources).toBe(undefined);
  expect(result.issues).toBe(undefined);
  for (const d of result.definitions) {
    expect(d.fields).toBe(undefined);
    expect(d.effective).toBe(undefined);
    expect(d.records).toBe(undefined);
  }
  const detail = checked(
    "ontology",
    await inspectOntology(vault, { view: "definitions", name: "project", includeRecords: true }),
  );
  expect(detail.total).toBe(1);
  expect(detail.definitions[0].fields.some((f: any) => f.name === "status")).toBeTruthy();
  expect(detail.definitions[0].source).toBeTruthy();
  expect(typeof detail.definitions[0].behaviors).toBe("object");
  expect(detail.definitions[0].records.length).toBeTruthy();
  expect(detail.definitions[0].effective).toBe(undefined);
  expect(
    JSON.stringify(result).length < JSON.stringify(await vault.inspectOntology()).length / 2,
  ).toBeTruthy();
  expect(checked("ontology", await inspectOntology(vault, { name: "missing" })).total).toBe(0);
});

it("ontology definition pages are exhaustive and JSON-safe; the UI follows all pages", async () => {
  const vault = new SampleVault();
  let offset = 0;
  const names = [];
  do {
    const page = checked(
      "ontology",
      await inspectOntology(vault, {
        view: "definitions",
        includeRecords: true,
        offset,
        limit: 10,
      }),
    );
    // The feature transport rejects undefined properties, including on relationships without behaviors.
    expect(page).toStrictEqual(jsonRoundTrip(page));
    names.push(...page.definitions.map((d: any) => d.name));
    offset = page.nextOffset;
  } while (offset !== null);
  expect(names.length).toBe(38);
  expect(new Set(names).size).toBe(38);
  // Force a small page size to exercise the real UI continuation helper.
  // loadVocabulary only calls invoke("ontology"); the fake serves it from the sample vault.
  const feature = {
    invoke: async (_: any, input: any) => inspectOntology(vault, { ...input, limit: 3 }),
  } as FeatureClient<typeof contract>;
  expect((await loadVocabulary(feature)).definitions.length).toBe(19);
  expect((await loadVocabulary(feature, true)).definitions.length).toBe(38);
  let calls = 0;
  await expect(
    loadVocabulary({
      invoke: async (_: any, input: any) => ({
        ...(await inspectOntology(vault, { ...input, limit: 3 })),
        fingerprint: String(calls++),
      }),
    } as FeatureClient<typeof contract>),
  ).rejects.toThrow(/changed while loading/);
});

it("source view is opt-in, bounded, and refuses arbitrary paths; invalid YAML remains diagnosable", async () => {
  const { root, vault } = await fixture(),
    broken = "format: [broken\n" + "# comment\n".repeat(80);
  await writeFile(path.join(root, "ontology.yaml"), broken);
  const catalog = checked("ontology", await inspectOntology(vault, {}));
  expect(catalog.available).toBe(false);
  expect(catalog.definitions.length).toBe(0);
  expect(catalog.totalIssues > 0).toBeTruthy();
  const sources = checked("ontology", await inspectOntology(vault, { view: "sources" }));
  expect(sources.sources.some((s: any) => s.path === "ontology.yaml" && !s.valid)).toBeTruthy();
  expect(sources.source).toBe(undefined);
  let raw = "",
    offset = 0;
  do {
    const page = checked(
      "ontology",
      await inspectOntology(vault, {
        view: "sources",
        sourcePath: "ontology.yaml",
        maxChars: 256,
        offset,
      }),
    );
    raw += page.source.raw;
    offset = page.nextOffset;
  } while (offset !== null);
  expect(raw).toBe(broken);
  const diagnostics = checked(
    "ontology",
    await inspectOntology(vault, { view: "diagnostics", limit: 1 }),
  );
  expect(diagnostics.issues.length).toBe(1);
  expect(diagnostics.nextOffset).toBeTruthy();
  await expect(
    inspectOntology(vault, { view: "sources", sourcePath: "../../etc/passwd" }),
  ).rejects.toThrow(/unavailable/);
  await expect(inspectOntology(vault, { sourcePath: "ontology.yaml" })).rejects.toThrow(
    /requires view=sources/,
  );
});

it("inspection inputs reject invalid budgets and authority selectors", () => {
  for (const input of [
    { id: "sample_person_alex", maxChars: 0 },
    { id: "sample_person_alex", referenceLimit: 101 },
    { id: "sample_person_alex", root: "/etc" },
  ]) {
    expect(Check(contract.operations.record.input, input)).toBe(false);
  }
  for (const input of [{ view: "all" }, { limit: 0 }, { offset: -1 }, { agent: "other" }]) {
    expect(Check(contract.operations.ontology.input, input)).toBe(false);
  }
});

it("byte-bounded evidence pages preserve every locator and make progress", async () => {
  const vault = new SampleVault(),
    detail = await vault.detail("sample_claim_pilot");
  const evidence = Array.from({ length: 30 }, (_, i) => ({
    ...detail.evidence[0],
    path: "evidence-" + i,
    attribution: "x".repeat(1000),
    quote: "🦞".repeat(1500),
  }));
  const fake = detailVault(async (_: any, start: any, limit: any) => ({
    ...structuredClone(detail),
    evidence: evidence.slice(start, start + limit),
    evidenceTotal: evidence.length,
    sourceFiles: [],
    identityEvidence: [],
    relatedStatements: [],
  }));
  let offset = 0;
  const paths = [];
  do {
    const result = checked(
      "record",
      await inspectRecord(fake, {
        id: detail.record!.id,
        view: "summary",
        includeEvidence: true,
        evidenceOffset: offset,
      }),
    );
    expect(Buffer.byteLength(JSON.stringify(result)) <= RECORD_RESPONSE_BYTES).toBeTruthy();
    paths.push(...result.evidence.map((e: any) => e.path));
    expect(result.nextEvidenceOffset === null || result.nextEvidenceOffset > offset).toBeTruthy();
    offset = result.nextEvidenceOffset;
  } while (offset !== null);
  expect(paths).toStrictEqual(evidence.map((e) => e.path));
});
