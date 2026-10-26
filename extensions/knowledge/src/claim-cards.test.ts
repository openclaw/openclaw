import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { connections } from "./connections.js";
import { contract } from "./contract.js";
import { jsonRoundTrip } from "./test-support.js";
import { SampleVault } from "./vault.js";

const ids = (rows: any[]) => rows.map((r) => r.id);
const checked = (op: keyof typeof contract.operations, result: any) => {
  expect(Check(contract.operations[op].output, result)).toBeTruthy();
  expect(result, "Card responses must be JSON-safe before host serialization").toStrictEqual(
    jsonRoundTrip(result),
  );
  return result;
};

it("claim cards use one scan per page, preserve pagination and omit evidence/full metadata", async () => {
  const vault = new SampleVault(),
    data = await vault.scan();
  const claim = data.records.find((r) => r.id === "sample_claim_pilot");
  const records = Array.from({ length: 55 }, (_, i) => ({
    ...claim!,
    id: i === 0 ? claim!.id : `sample_claim_${i}`,
    body: "x".repeat(5000),
    metadata: {
      ...claim!.metadata,
      id: i === 0 ? claim!.id : `sample_claim_${i}`,
      custom_note: "Not card data",
    },
  }));
  data.records = [...data.records.filter((r) => r.kind !== "claim"), ...records];
  let scans = 0;
  vault.scan = async () => {
    scans++;
    return data;
  };
  vault.detail = () => {
    throw new Error("Card lists must not call detail");
  };
  const first = checked(
    "records",
    await vault.list({ kind: "claim", includeCards: true, limit: 50 }),
  );
  expect(scans).toBe(1);
  expect(first.records.length > 0 && first.records.length <= 50).toBeTruthy();
  expect(first.total).toBe(55);
  expect(first.nextOffset).toBe(first.records.length);
  for (const row of first.records) {
    expect(row.card.body.length).toBe(4000);
    expect(row.card.truncated).toBe(true);
    expect(row.card.hash).toBe(claim!.hash);
    expect(row.card.evidenceTotal).toBe(claim!.metadata.evidence!.length);
    expect(row.card.assertionOrigin).toBe(claim!.metadata.assertion_origin);
    expect(row.card.evidence).toBe(undefined);
    expect(row.card.metadata.evidence).toBe(undefined);
    expect(row.card.metadata.custom_note).toBe(undefined);
  }
  const last = checked(
    "records",
    await vault.list({ kind: "claim", includeCards: true, offset: first.nextOffset, limit: 50 }),
  );
  expect(scans).toBe(2);
  expect(last.records.length).toBe(55 - first.records.length);
  expect(last.nextOffset).toBe(null);
  expect(new Set([...first.records, ...last.records].map((r) => r.id)).size).toBe(55);
  const concise = checked("records", await vault.list({ kind: "claim" }));
  expect(concise.records.every((r: any) => !r.card)).toBeTruthy();
});

it("relationship browse batches deduplicated eligible endpoints in one scan per page", async () => {
  const vault = new SampleVault(),
    data = await vault.scan();
  const edge = data.records.find((r) => r.kind === "relationship");
  expect(edge).toBeTruthy();
  const edges = Array.from({ length: 55 }, (_, i) => ({
    ...edge!,
    id: `edge_${i}`,
    metadata: { ...edge!.metadata, id: `edge_${i}` },
  }));
  data.records = [...data.records.filter((r) => r.kind !== "relationship"), ...edges];
  let scans = 0;
  vault.scan = async () => {
    scans++;
    return data;
  };
  vault.detail = () => {
    throw new Error("Endpoint lists must not call detail");
  };
  const first = checked(
    "records",
    await vault.list({ kind: "relationship", includeEndpoints: true, limit: 50 }),
  );
  expect(scans).toBe(1);
  expect(first.records.length).toBe(50);
  expect(first.nextOffset).toBe(50);
  expect(new Set(ids(first.endpoints))).toStrictEqual(
    new Set([edge!.metadata.from, edge!.metadata.to]),
  );
  for (const endpoint of first.endpoints) {
    expect(endpoint.body).toBe(undefined);
    expect(endpoint.evidence).toBe(undefined);
  }
  const last = checked(
    "records",
    await vault.list({ kind: "relationship", includeEndpoints: true, offset: 50, limit: 50 }),
  );
  expect(scans).toBe(2);
  expect(last.records.length).toBe(5);
  expect(last.nextOffset).toBe(null);
  expect((await vault.list({ kind: "relationship" })).endpoints, "Projection remains opt-in").toBe(
    undefined,
  );
  const target = data.records.find((r) => r.id === edge!.metadata.from);
  target!.lifecycle = "withdrawn";
  target!.metadata.lifecycle = "withdrawn";
  const historical = checked(
    "records",
    await vault.list({ kind: "relationship", lifecycle: "all", includeEndpoints: true }),
  );
  expect(historical.records.length).toBe(50);
  // History must not leak unavailable endpoint content.
  expect(ids(historical.endpoints)).not.toContain(target!.id);
  target!.lifecycle = "active";
  target!.metadata.lifecycle = "active";
  data.records.push({ ...target!, path: "duplicate.md" });
  // Ambiguous endpoint identities are withheld.
  const ambiguous = await vault.list({
    kind: "relationship",
    lifecycle: "all",
    includeEndpoints: true,
  });
  expect(ids(ambiguous.endpoints!)).not.toContain(target!.id);
  const pages = checked("records", await vault.list({ kind: "page", includeEndpoints: true }));
  expect(pages.endpoints, "Only relationships on this page contribute endpoints").toStrictEqual([]);
});

it("connection pages batch only current unambiguous endpoints on the requested page", async () => {
  const data = await new SampleVault().scan();
  const edge = data.records.find((r) => r.kind === "relationship");
  const input = {
    id: edge!.metadata.from!,
    direction: "outgoing",
    includeEndpoints: true,
    limit: 1,
  } as const;
  const first = checked("connections", connections(data, input));
  expect(new Set(ids(first.endpoints))).toStrictEqual(
    new Set([edge!.metadata.from, edge!.metadata.to]),
  );
  expect(
    first.endpoints.every((r: any) => r.body === undefined && r.evidence === undefined),
  ).toBeTruthy();
  expect(connections(data, { ...input, includeEndpoints: false }).endpoints).toBe(undefined);
  expect(connections(data, { ...input, offset: 100 }).endpoints).toStrictEqual([]);
  const target = data.records.find((r) => r.id === edge!.metadata.to);
  target!.lifecycle = "withdrawn";
  target!.metadata.lifecycle = "withdrawn";
  const historical = () =>
    checked("connections", connections(data, { ...input, historical: true }));
  expect(ids(historical().endpoints)).not.toContain(target!.id);
  target!.lifecycle = "active";
  target!.metadata.lifecycle = "active";
  data.records.push({ ...target!, path: "duplicate.md" });
  expect(ids(historical().endpoints)).not.toContain(target!.id);
});
