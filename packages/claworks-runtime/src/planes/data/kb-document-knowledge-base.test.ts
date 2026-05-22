import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";
import { createDocumentKnowledgeBase } from "./kb-document-knowledge-base.js";
import { createKnowledgeBase } from "./knowledge-base.js";

describe("createDocumentKnowledgeBase", () => {
  it("ingests, publishes, and searches with document metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-doc-kb-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);
    const kb = createDocumentKnowledgeBase(db, createKnowledgeBase());

    const draft = await kb.ingestDocument({
      text: "Pump seal replacement procedure for unit B",
      source: "pump-sop.md",
      namespace: "maintenance",
      auto_publish: false,
    });
    expect(draft.status).toBe("draft");

    const lint = kb.lintDocument(draft.id);
    expect(lint.ok).toBe(true);

    const published = await kb.publishDocument(draft.id);
    expect(published.status).toBe("published");

    const hits = await kb.search("pump seal", { namespace: "maintenance", limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.document_id).toBe(draft.id);
    expect(hits[0]?.layer).toBe("L2");
    expect(hits[0]?.citation).toBeTruthy();

    const status = await kb.describe?.();
    expect(status?.provider).toBe("document");
    expect(status?.published_document_count).toBe(1);
    close();
  });

  it("processes inline ingest jobs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-doc-kb-job-"));
    const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);
    const kb = createDocumentKnowledgeBase(db, createKnowledgeBase());

    const job = kb.createIngestJob({
      text: "Emergency shutdown checklist",
      title: "ESD checklist",
      namespace: "ops",
      auto_publish: true,
    });
    const completed = await kb.processIngestJob(job.id);
    expect(completed.status).toBe("completed");
    expect((completed.report.documents as unknown[]).length).toBe(1);
    close();
  });
});
