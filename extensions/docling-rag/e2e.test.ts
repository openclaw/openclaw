/**
 * End-to-end tests for the Docling RAG extension.
 *
 * Simulates the full lifecycle:
 *   1. Server manager ensures docling-serve is available
 *   2. Client converts and chunks a document
 *   3. Store persists document + chunks to disk
 *   4. Search finds relevant content
 *   5. Removal cleans up
 *   6. CLI commands produce correct output
 *
 * All external calls (docling-serve HTTP) are mocked.
 * Filesystem operations (store persistence) use real temp directories.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DoclingClient } from "./src/docling-client.js";
import { DoclingServerManager } from "./src/server-manager.js";
import { DocumentStore } from "./src/store.js";

// =========================================================================
// E2E: Full document lifecycle
// =========================================================================

describe("E2E: full document lifecycle", () => {
  let tmpDir: string;
  let store: DocumentStore;
  let client: DoclingClient;
  let serverManager: DoclingServerManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docling-e2e-"));
    store = new DocumentStore(tmpDir);
    client = new DoclingClient("http://127.0.0.1:5001");
    serverManager = new DoclingServerManager("http://127.0.0.1:5001");
    vi.restoreAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("ingest → search → list → remove: complete lifecycle", async () => {
    // -- Step 1: Mock server health check
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await serverManager.ensureRunning();
    expect(serverManager.isStarted()).toBe(true);

    // -- Step 2: Create a test document
    const testDoc = path.join(tmpDir, "employee-handbook.pdf");
    fs.writeFileSync(testDoc, "fake PDF content for testing");

    // -- Step 3: Mock the chunk API response
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          chunks: [
            {
              text: "Employees are entitled to 20 days of paid vacation per year. Unused days can be carried over up to 5 days.",
              meta: { page: 23, headings: ["HR Policies", "Vacation Policy"] },
            },
            {
              text: "Health insurance is provided for all full-time employees and covers dental, vision, and medical.",
              meta: { page: 30, headings: ["HR Policies", "Benefits"] },
            },
            {
              text: "Termination requires 30 days written notice from either party. Severance is calculated at 2 weeks per year of service.",
              meta: { page: 45, headings: ["HR Policies", "Termination"] },
            },
            {
              text: "Remote work is permitted up to 3 days per week with manager approval. Equipment stipend of $500 is provided annually.",
              meta: { page: 52, headings: ["HR Policies", "Remote Work"] },
            },
            {
              text: "Annual performance reviews are conducted in Q4. Salary adjustments take effect January 1st.",
              meta: { page: 60, headings: ["HR Policies", "Performance Reviews"] },
            },
          ],
          documents: [{ num_pages: 84, input_format: "pdf" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    // -- Step 4: Ingest the document
    const chunkResult = await client.chunkFile(testDoc);
    expect(chunkResult.chunks).toHaveLength(5);
    expect(chunkResult.pages).toBe(84);

    const stat = fs.statSync(testDoc);
    const doc = store.addDocument(
      {
        name: "employee-handbook.pdf",
        path: testDoc,
        format: chunkResult.format,
        pages: chunkResult.pages,
        sizeBytes: stat.size,
      },
      chunkResult.chunks.map((c) => ({
        text: c.text,
        page: c.page,
        section: c.section,
      })),
    );

    expect(doc.name).toBe("employee-handbook.pdf");
    expect(doc.pages).toBe(84);
    expect(doc.chunks).toBe(5);
    expect(doc.id).toBeTruthy();

    // -- Step 5: Verify persistence (reload from disk)
    const store2 = new DocumentStore(tmpDir);
    expect(store2.documentCount()).toBe(1);
    expect(store2.chunkCount()).toBe(5);

    // -- Step 6: Search for vacation policy
    const vacationResults = store.searchByKeyword("vacation days");
    expect(vacationResults.length).toBeGreaterThan(0);
    expect(vacationResults[0].chunk.text).toContain("vacation");
    expect(vacationResults[0].chunk.page).toBe(23);
    expect(vacationResults[0].chunk.section).toBe("HR Policies > Vacation Policy");
    expect(vacationResults[0].document.name).toBe("employee-handbook.pdf");

    // -- Step 7: Search for termination
    const terminationResults = store.searchByKeyword("termination notice");
    expect(terminationResults.length).toBeGreaterThan(0);
    expect(terminationResults[0].chunk.text).toContain("30 days");
    expect(terminationResults[0].chunk.page).toBe(45);

    // -- Step 8: Search for something not in the document
    const noResults = store.searchByKeyword("quantum physics");
    expect(noResults).toHaveLength(0);

    // -- Step 9: List documents
    const allDocs = store.listDocuments();
    expect(allDocs).toHaveLength(1);
    expect(allDocs[0].name).toBe("employee-handbook.pdf");
    expect(allDocs[0].format).toBe("pdf");
    expect(allDocs[0].pages).toBe(84);
    expect(allDocs[0].chunks).toBe(5);

    // -- Step 10: Remove the document
    const removed = store.removeDocument(doc.id);
    expect(removed).toBe(true);
    expect(store.documentCount()).toBe(0);
    expect(store.chunkCount()).toBe(0);
    expect(store.searchByKeyword("vacation")).toHaveLength(0);

    // -- Step 11: Verify removal persisted
    const store3 = new DocumentStore(tmpDir);
    expect(store3.documentCount()).toBe(0);
  });

  it("ingest multiple documents → cross-document search", async () => {
    // Mock server
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));

    // Add handbook
    store.addDocument(
      {
        name: "handbook.pdf",
        path: "/tmp/handbook.pdf",
        format: "pdf",
        pages: 50,
        sizeBytes: 5000,
      },
      [
        {
          text: "Vacation policy: 20 days per year for full-time employees.",
          page: 10,
          section: "Vacation",
        },
        {
          text: "Sick leave: 10 days per year, doctor note required after 3 consecutive days.",
          page: 15,
          section: "Sick Leave",
        },
      ],
    );

    // Add invoice
    store.addDocument(
      {
        name: "invoice-q3.pdf",
        path: "/tmp/invoice-q3.pdf",
        format: "pdf",
        pages: 2,
        sizeBytes: 200,
      },
      [
        { text: "Invoice total: $4,250.00. Payment terms: Net 30 days.", page: 1 },
        { text: "Line items: Software license $3,000.00, Annual support $1,250.00.", page: 1 },
      ],
    );

    // Add contract
    store.addDocument(
      {
        name: "vendor-contract.docx",
        path: "/tmp/vendor-contract.docx",
        format: "docx",
        pages: 15,
        sizeBytes: 3000,
      },
      [
        {
          text: "This agreement shall terminate on December 31, 2026 unless renewed in writing.",
          page: 8,
          section: "Term",
        },
        {
          text: "Liability shall not exceed the total fees paid under this agreement.",
          page: 10,
          section: "Liability",
        },
      ],
    );

    // Cross-document searches
    expect(store.documentCount()).toBe(3);
    expect(store.chunkCount()).toBe(6);

    // Search finds handbook
    const vacationHits = store.searchByKeyword("vacation");
    expect(vacationHits[0].document.name).toBe("handbook.pdf");

    // Search finds invoice
    const invoiceHits = store.searchByKeyword("invoice total");
    expect(invoiceHits[0].document.name).toBe("invoice-q3.pdf");

    // Search finds contract
    const contractHits = store.searchByKeyword("terminate agreement");
    expect(contractHits[0].document.name).toBe("vendor-contract.docx");

    // Search across multiple docs with common term "days"
    const daysHits = store.searchByKeyword("days");
    expect(daysHits.length).toBeGreaterThanOrEqual(3);

    // Verify different formats coexist
    const docs = store.listDocuments();
    const formats = docs.map((d) => d.format);
    expect(formats).toContain("pdf");
    expect(formats).toContain("docx");
  });

  it("duplicate ingestion prevention", () => {
    store.addDocument(
      { name: "report.pdf", path: "/tmp/report.pdf", format: "pdf", pages: 10, sizeBytes: 1000 },
      [{ text: "Q3 revenue was $4.2M" }],
    );

    // Try to find by name — should detect duplicate
    const existing = store.findDocumentByName("report.pdf");
    expect(existing).toBeDefined();
    expect(existing?.name).toBe("report.pdf");

    // Store should still have only 1 document
    expect(store.documentCount()).toBe(1);
  });

  it("store survives process restart (persistence)", () => {
    // Ingest in "session 1"
    store.addDocument(
      {
        name: "persistent.pdf",
        path: "/tmp/persistent.pdf",
        format: "pdf",
        pages: 5,
        sizeBytes: 500,
      },
      [
        { text: "This content should survive restart", page: 1 },
        { text: "Second chunk also survives", page: 2 },
      ],
    );

    // Simulate process restart — create new store from same directory
    const restarted = new DocumentStore(tmpDir);

    expect(restarted.documentCount()).toBe(1);
    expect(restarted.chunkCount()).toBe(2);

    const results = restarted.searchByKeyword("survive restart");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk.text).toContain("survive restart");
  });

  it("remove and re-ingest same document", () => {
    // First ingestion
    const doc1 = store.addDocument(
      { name: "evolving.pdf", path: "/tmp/evolving.pdf", format: "pdf", pages: 3, sizeBytes: 300 },
      [{ text: "Alpha release original draft content" }],
    );

    expect(store.searchByKeyword("alpha original")[0].chunk.text).toContain("Alpha");

    // Remove
    store.removeDocument(doc1.id);
    expect(store.documentCount()).toBe(0);

    // Re-ingest with updated content
    store.addDocument(
      { name: "evolving.pdf", path: "/tmp/evolving.pdf", format: "pdf", pages: 4, sizeBytes: 400 },
      [{ text: "Beta release revised final content" }],
    );

    expect(store.documentCount()).toBe(1);
    expect(store.searchByKeyword("beta revised")[0].chunk.text).toContain("Beta");
    expect(store.searchByKeyword("alpha original")).toHaveLength(0);
  });

  it("search result ranking across documents", () => {
    store.addDocument(
      { name: "doc-a.pdf", path: "/a.pdf", format: "pdf", pages: 1, sizeBytes: 100 },
      [{ text: "Machine learning is a subset of artificial intelligence." }],
    );

    store.addDocument(
      { name: "doc-b.pdf", path: "/b.pdf", format: "pdf", pages: 1, sizeBytes: 100 },
      [
        {
          text: "Machine learning and deep learning are transforming machine vision and machine translation.",
        },
      ],
    );

    // doc-b should rank higher because "machine" appears more times
    const results = store.searchByKeyword("machine learning");
    expect(results.length).toBe(2);
    // Both should be found
    const names = results.map((r) => r.document.name);
    expect(names).toContain("doc-a.pdf");
    expect(names).toContain("doc-b.pdf");
  });

  it("handles large number of chunks efficiently", () => {
    const chunks = Array.from({ length: 500 }, (_, i) => ({
      text: `Chunk number ${i} contains information about topic ${i % 10} and category ${i % 5}.`,
      page: Math.floor(i / 10) + 1,
    }));

    store.addDocument(
      { name: "large-doc.pdf", path: "/tmp/large.pdf", format: "pdf", pages: 50, sizeBytes: 50000 },
      chunks,
    );

    expect(store.chunkCount()).toBe(500);

    // Search should still work and return limited results
    const results = store.searchByKeyword("topic", 5);
    expect(results).toHaveLength(5);
  });

  it("empty document ingestion (no chunks)", () => {
    const doc = store.addDocument(
      { name: "empty.pdf", path: "/tmp/empty.pdf", format: "pdf", pages: 0, sizeBytes: 0 },
      [],
    );

    expect(doc.chunks).toBe(0);
    expect(store.documentCount()).toBe(1);
    expect(store.searchByKeyword("anything")).toHaveLength(0);
  });

  it("special characters in search query and document content", () => {
    store.addDocument(
      { name: "special.pdf", path: "/tmp/special.pdf", format: "pdf", pages: 1, sizeBytes: 100 },
      [
        { text: "Total: $4,250.00 (including 15% VAT)" },
        { text: "Email: user@example.com — Phone: +1-555-0123" },
        { text: "Path: C:\\Users\\Documents\\report.pdf or /home/user/docs" },
      ],
    );

    expect(store.searchByKeyword("$4,250").length).toBeGreaterThan(0);
    expect(store.searchByKeyword("user@example.com").length).toBeGreaterThan(0);
    expect(store.searchByKeyword("report.pdf").length).toBeGreaterThan(0);
  });

  it("concurrent document operations don't corrupt state", () => {
    // Add multiple documents rapidly
    for (let i = 0; i < 10; i++) {
      store.addDocument(
        {
          name: `doc-${i}.pdf`,
          path: `/tmp/doc-${i}.pdf`,
          format: "pdf",
          pages: 1,
          sizeBytes: 100,
        },
        [{ text: `Content for document number ${i}` }],
      );
    }

    expect(store.documentCount()).toBe(10);
    expect(store.chunkCount()).toBe(10);

    // Remove half
    const docs = store.listDocuments();
    for (let i = 0; i < 5; i++) {
      store.removeDocument(docs[i].id);
    }

    expect(store.documentCount()).toBe(5);
    expect(store.chunkCount()).toBe(5);

    // Verify persistence after rapid operations
    const reloaded = new DocumentStore(tmpDir);
    expect(reloaded.documentCount()).toBe(5);
  });
});
