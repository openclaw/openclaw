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
  // Fixture metadata carries only the envelope fields connections read; IDs follow the ID pattern.
  metadata: { lifecycle: "active", ...extra } as Envelope,
});
const fixture = (count = 1): ScanResult => ({
  records: [
    rec("node-aaa"),
    rec("node-bbb"),
    ...Array.from({ length: count }, (_, i) => ({
      ...rec(`edge-${i}`, {
        from: "node-aaa",
        to: "node-bbb",
        label: "attended",
        attribution_confidence: {
          level: "low",
          basis: "Speaker unresolved",
          // The longest quote the evidence schema allows.
          evidence: [
            { path: "source.txt", sha256: "a".repeat(64), quote: "expensive".repeat(444) },
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
it("compact default rows keep graph identity and uncertainty without evidence; rich response remains explicit", () => {
  const data = fixture();
  const small = checked(connections(data, { id: "node-aaa", includeEndpoints: true })),
    full = checked(connections(data, { id: "node-aaa", view: "full", includeEndpoints: true }));
  // A single page has no next page to compare a snapshot against.
  expect(small.snapshot).toBe(undefined);
  expect(full.snapshot).toBeTruthy();
  expect(small.total).toBe(full.total);
  expect(small.connections[0]).toStrictEqual({
    direction: "outgoing",
    id: "edge-0",
    title: "edge-0",
    type: "attended",
    revision: 1,
    hash: "edge-0",
    from: "node-aaa",
    to: "node-bbb",
    attributionConfidence: "low",
  });
  expect(small.endpoints[0]).toStrictEqual({
    id: "node-aaa",
    title: "node-aaa",
    type: "person",
    revision: 1,
    hash: "node-aaa",
  });
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
        connections(data, { id: "node-aaa", view, includeEndpoints: true, limit: 100, offset }),
      );
      expect(page.connections.length).toBeTruthy();
      if (view === "full") {
        expect(page.connections.length < 80).toBeTruthy();
      }
      expect(page.endpoints.length).toBe(2);
      ids.push(...page.connections.map((r: any) => (view === "full" ? r.record.id : r.id)));
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
  expect(() => connections(data, { id: "node-aaa", view: "full" })).toThrow(/response budget/);
  expect(checked(connections(data, { id: "node-aaa" })).connections.length).toBe(1);
});
