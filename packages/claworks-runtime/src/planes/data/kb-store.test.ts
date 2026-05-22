import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";
import { createKbStore, hashKbContent } from "./kb-store.js";

describe("kb-store", () => {
  it("inserts documents, chunks, and searches published text", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-kb-store-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);
    const store = createKbStore(db);

    const doc = store.insertDocument({
      title: "Test SOP",
      source: "sop.md",
      layer: "L2",
      namespace: "work",
      status: "published",
      content_hash: hashKbContent("valve inspection steps"),
    });
    store.insertChunks(doc.id, [{ text: "valve inspection steps", citation: "sop.md#1" }]);

    expect(store.countDocuments()).toBe(1);
    expect(store.countChunks()).toBe(1);

    const hits = store.searchPublishedChunks({ query: "valve", namespace: "work", limit: 5 });
    expect(hits.length).toBe(1);
    expect(hits[0]?.document.id).toBe(doc.id);

    const job = store.createIngestJob({ text: "inline", namespace: "work" });
    expect(job.status).toBe("pending");
    close();
  });
});
