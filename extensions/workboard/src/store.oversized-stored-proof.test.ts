import { expectDefined } from "@openclaw/normalization-core";
import type { WorkboardProof } from "@openclaw/workboard-contract";
import { describe, expect, it } from "vitest";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

describe("Workboard oversized stored proof notes", () => {
  it("preserves a legacy over-cap stored note through card updates", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const card = await store.create({ title: "Legacy proof" });
    const note = `  ${"y".repeat(2001)}\n`;
    const legacyProof: WorkboardProof = {
      id: "legacy-proof",
      status: "unknown",
      createdAt: 1,
      note,
    };
    // Seed legacy data through the persistence owner, below new-input validation.
    await stores.cards.register(card.id, {
      version: 1,
      card: {
        ...card,
        metadata: { ...card.metadata, proof: [legacyProof] },
      },
    });

    const updated = await store.update(card.id, { title: "Still mutable" });
    expect(updated.metadata?.proof).toEqual([legacyProof]);

    const withNew = await store.addProof(card.id, { label: "check" });
    expect(withNew.metadata?.proof?.map((proof) => proof.note)).toEqual([note, undefined]);

    await expect(store.addProof(card.id, { note })).rejects.toThrow(
      "proof note must be 2000 characters or fewer",
    );
    const stored = expectDefined(updated.metadata?.proof?.[0], "stored proof");
    await expect(
      store.update(card.id, { metadata: { proof: [{ ...stored, note: `${note} edited` }] } }),
    ).rejects.toThrow("proof note must be 2000 characters or fewer");
  });
});
