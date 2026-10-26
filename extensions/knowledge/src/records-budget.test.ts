import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import { hostJsonBoundary } from "./host-json-test-support.js";
import type { LoadedRecord } from "./model.js";
import { SampleVault } from "./vault.js";
// Exercise the host's actual boundary through the SDK, not a copy of our budget helper.
const isHostJson = hostJsonBoundary();
it("real host JSON boundary is checked", async () => {
  expect(await isHostJson({ ok: true })).toBe(true);
  expect(await isHostJson({ text: "x".repeat(2 * 1024 * 1024) })).toBe(false);
});

// Synthetic evidence entries; a quote adds payload bytes.
const evidenceList = (count: number, quote = "") =>
  Array.from({ length: count }, () => ({
    path: "sources/sample.txt",
    sha256: "a".repeat(64),
    start_line: 1,
    end_line: 2,
    ...(quote ? { quote } : {}),
  }));
async function fixture(count: any, evidenceCount: any, body: any, quote = "") {
  const vault = new SampleVault(),
    data = await vault.scan();
  const template = data.records.find((r) => r.id === "sample_claim_pilot");
  const evidence = evidenceList(evidenceCount, quote);
  const claims = Array.from({ length: count }, (_, i): LoadedRecord => ({
    ...template!,
    id: i === 0 ? template!.id : `claim_${String(i).padStart(3, "0")}`,
    title: `Claim ${i}`,
    body,
    metadata: {
      ...template!.metadata,
      attribution_confidence: { level: "medium", basis: "Synthetic attribution", evidence },
    },
  }));
  data.records = [...data.records.filter((r) => r.kind !== "claim"), ...claims];
  let scans = 0;
  vault.scan = async () => {
    scans++;
    return data;
  };
  return { vault, data, claims, scans: () => scans };
}
async function valid(result: any) {
  expect(Check(contract.operations.records.output, result), "records contract").toBeTruthy();
  expect(await isHostJson(result), "actual host nested-value and byte limits").toBeTruthy();
  return result;
}
for (const [name, evidenceCount, body] of [
  ["nodes", 20, "Synthetic claim."],
  ["utf8 bytes", 1, "界".repeat(4000)],
]) {
  it(`Browse bounds ${name} and continues without gaps or duplicates`, async () => {
    const { vault, claims, scans } = await fixture(80, evidenceCount, body);
    const seen = [];
    let offset = 0,
      calls = 0;
    do {
      const result = await valid(
        await vault.list({ kind: "claim", includeCards: true, limit: 50, offset }),
      );
      calls++;
      expect(result.offset).toBe(offset);
      expect(result.total).toBe(80);
      expect(result.records.length > 0 && result.records.length < 50).toBeTruthy();
      expect(result.facets.kinds[claims[0]!.type!]).toBe(80);
      expect(result.nextOffset).toBe(
        offset + result.records.length < 80 ? offset + result.records.length : null,
      );
      seen.push(...result.records.map((r: any) => r.id));
      offset = result.nextOffset;
    } while (offset !== null);
    expect(scans(), "one authorized scan per page").toBe(calls);
    expect(seen).toStrictEqual(claims.map((r) => r.id).toSorted((a, b) => a.localeCompare(b)));
  });
}
it("single oversized Browse claim retains a clickable summary and attribution uncertainty", async () => {
  const { vault } = await fixture(2, 20, "Synthetic claim.", "界".repeat(4000));
  const first = await valid(await vault.list({ kind: "claim", includeCards: true, limit: 50 }));
  expect(first.records.length).toBe(1);
  expect(first.nextOffset).toBe(1);
  expect(first.records[0].card).toBe(undefined);
  expect(first.records[0].attributionConfidence).toStrictEqual({
    level: "medium",
    basis: "Synthetic attribution",
  });
  const last = await valid(
    await vault.list({ kind: "claim", includeCards: true, offset: first.nextOffset }),
  );
  expect(last.nextOffset).toBe(null);
  expect(last.records[0].id).not.toBe(first.records[0].id);
});
it("relationship endpoint payload participates in the Browse budget", async () => {
  const vault = new SampleVault(),
    data = await vault.scan();
  vault.scan = async () => data;
  const endpoints = data.records.filter((r) => r.kind === "page").slice(0, 2);
  for (const r of endpoints) {
    r.metadata.attribution_confidence = {
      level: "low",
      basis: "Synthetic uncertainty",
      evidence: evidenceList(20, "界".repeat(4000)),
    };
  }
  const edge = data.records.find((r) => r.kind === "relationship");
  data.records = [
    ...data.records.filter((r) => r.kind !== "relationship"),
    ...Array.from({ length: 3 }, (_, i) => ({
      ...edge!,
      id: `edge_${i}`,
      metadata: { ...edge!.metadata, from: endpoints[0]!.id, to: endpoints[1]!.id },
    })),
  ];
  const seen = [];
  let offset = 0;
  do {
    const result = await valid(
      await vault.list({ kind: "relationship", includeEndpoints: true, offset }),
    );
    expect(result.records.length).toBe(1);
    expect(result.endpoints.length).toBe(2);
    expect(
      result.endpoints.every((r: any) => r.attributionConfidence.level === "low"),
    ).toBeTruthy();
    seen.push(result.records[0].id);
    offset = result.nextOffset;
  } while (offset !== null);
  expect(new Set(seen).size).toBe(3);
});
