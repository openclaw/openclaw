import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { ConnectionsOutput } from "./connections-contract.js";
import { connections, CONNECTION_RESPONSE_BYTES } from "./connections.js";
import type { Envelope, LoadedRecord } from "./model.js";
import type { ScanResult } from "./vault.js";
const rec = (id: string, extra: Partial<Envelope> = {}): LoadedRecord => ({
  id,
  title: id,
  kind: "page",
  type: "person",
  path: `people/${id}.md`,
  hash: id,
  revision: 1,
  lifecycle: "active",
  valid: true,
  body: "",
  raw: "",
  // Fixture metadata carries only the envelope fields connections read.
  metadata: { lifecycle: "active", ...extra } as Envelope,
});
const fixture = (count = 1): ScanResult => ({
  records: [
    rec("a"),
    rec("b"),
    ...Array.from({ length: count }, (_, i) => ({
      ...rec(`edge-${i}`, {
        from: "a",
        to: "b",
        label: "attended",
        attribution_confidence: {
          level: "low",
          basis: "Speaker unresolved",
          evidence: [
            { path: "source.txt", sha256: "a".repeat(64), quote: "expensive".repeat(1500) },
          ],
        },
      }),
      kind: "relationship",
      type: "attended",
    })),
  ],
  ontology: null,
  sources: [],
  issues: [],
  checkedAt: "",
});
const checked = (r: any) => {
  expect(Check(ConnectionsOutput, r)).toBeTruthy();
  expect(Buffer.byteLength(JSON.stringify(r)) <= CONNECTION_RESPONSE_BYTES).toBeTruthy();
  return r;
};
it("compact default retains uncertainty and graph identity without evidence; rich response remains explicit", () => {
  const data = fixture();
  const small = checked(connections(data, { id: "a", includeEndpoints: true })),
    full = checked(connections(data, { id: "a", view: "full", includeEndpoints: true }));
  expect(small.snapshot).toBe(full.snapshot);
  expect(small.total).toBe(full.total);
  expect(small.connections[0].from).toBe("a");
  expect(small.connections[0].record.attributionConfidence.level).toBe("low");
  expect(small.connections[0].record.attributionConfidence.evidence).toBe(undefined);
  expect(small.connections[0].record.path).toBe(undefined);
  expect(small.connections[0].evidence).toBe(undefined);
  expect(small.endpoints[0].path).toBe(undefined);
  expect(full.connections[0].record.path).toBeTruthy();
  expect(full.connections[0].record.attributionConfidence.evidence.length).toBe(1);
});
it("byte-bounded pages remain valid and exhaustive with Unicode, escaping and deduplicated endpoints", () => {
  const data = fixture(80);
  for (const r of data.records) {
    r.title = '"東京\\'.repeat(35);
  }
  for (const view of ["compact", "full"] as const) {
    let offset = 0;
    const ids = [];
    do {
      const page = checked(
        connections(data, { id: "a", view, includeEndpoints: true, limit: 100, offset }),
      );
      expect(page.connections.length).toBeTruthy();
      expect(page.connections.length < 80).toBeTruthy();
      expect(page.endpoints.length).toBe(2);
      ids.push(...page.connections.map((r: any) => r.record.id));
      if (page.nextOffset !== null) {
        expect(page.nextOffset).toBe(offset + page.connections.length);
      }
      offset = page.nextOffset;
    } while (offset !== null);
    expect(ids.length).toBe(80);
    expect(new Set(ids).size).toBe(80);
  }
});
it("one oversized full row fails explicitly; default still works", () => {
  const data = fixture();
  data.records[2]!.metadata.attribution_confidence!.evidence[0]!.quote = "x".repeat(30000);
  expect(() => connections(data, { id: "a", view: "full" })).toThrow(/response budget/);
  expect(checked(connections(data, { id: "a" })).connections.length).toBe(1);
});
