import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import { SampleVault } from "./vault.js";

const records = contract.operations.records;

/** Browse pages are what `knowledge_records` hands back as its own next request. */
async function browse(count: number, limit: number) {
  const vault = new SampleVault();
  const data = await vault.scan();
  const claim = data.records.find((r) => r.kind === "claim")!;
  for (let i = 0; i < count; i++) {
    const id = `continuation_probe_${String(i).padStart(3, "0")}`;
    data.records.push({ ...claim, id, metadata: { ...claim.metadata, id } } as typeof claim);
  }
  vault.scan = async () => data;
  return (offset: number) => vault.list({ kind: "claim", limit, offset });
}

it("accepts the continuation offset Browse returns for its own inventory", async () => {
  const page = await browse(503, 1);
  const seen: string[] = [];
  let offset = 0;
  for (;;) {
    expect(Check(records.input, { kind: "claim", limit: 1, offset })).toBe(true);
    const result = await page(offset);
    seen.push(...result.records.map((row: { id: string }) => row.id));
    if (result.nextOffset === null) {
      expect(result.total).toBe(seen.length);
      break;
    }
    offset = result.nextOffset;
  }
  expect(seen.length).toBeGreaterThan(501);
  expect(new Set(seen).size).toBe(seen.length);
});

it("keeps the offset contract for negative values", () => {
  expect(Check(records.input, { offset: 0 })).toBe(true);
  expect(Check(records.input, { offset: 501 })).toBe(true);
  expect(Check(records.input, { offset: -1 })).toBe(false);
});
