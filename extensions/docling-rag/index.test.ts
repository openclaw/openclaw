import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DoclingClient, DoclingClientError } from "./src/docling-client.js";
import { DoclingServerManager } from "./src/server-manager.js";
import { DocumentStore } from "./src/store.js";
import { SUPPORTED_EXTENSIONS } from "./src/types.js";

// =========================================================================
// DoclingClient
// =========================================================================

describe("DoclingClient", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docling-client-test-"));
    vi.restoreAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("healthCheck", () => {
    it("returns true when server is healthy", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("ok", { status: 200 }));
      const client = new DoclingClient("http://localhost:5001");
      expect(await client.healthCheck()).toBe(true);
    });

    it("returns false when server is down", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const client = new DoclingClient("http://localhost:5001");
      expect(await client.healthCheck()).toBe(false);
    });

    it("returns false on non-200 response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("error", { status: 500 }));
      const client = new DoclingClient("http://localhost:5001");
      expect(await client.healthCheck()).toBe(false);
    });
  });

  describe("convertFile", () => {
    it("throws on missing file", async () => {
      const client = new DoclingClient("http://localhost:5001");
      await expect(client.convertFile("/nonexistent/file.pdf")).rejects.toThrow(DoclingClientError);
    });

    it("sends file and parses response", async () => {
      const testFile = path.join(tmpDir, "test.pdf");
      fs.writeFileSync(testFile, "fake pdf content");

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            document: {
              md_content: "# Test Document\n\nHello world",
              num_pages: 3,
              input_format: "pdf",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const client = new DoclingClient("http://localhost:5001");
      const result = await client.convertFile(testFile);
      expect(result.markdown).toContain("Hello world");
      expect(result.pages).toBe(3);
      expect(result.format).toBe("pdf");
    });

    it("throws on server error", async () => {
      const testFile = path.join(tmpDir, "test.pdf");
      fs.writeFileSync(testFile, "fake pdf content");

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Internal Server Error", { status: 500 }),
      );

      const client = new DoclingClient("http://localhost:5001");
      await expect(client.convertFile(testFile)).rejects.toThrow(DoclingClientError);
    });

    it("handles empty document response", async () => {
      const testFile = path.join(tmpDir, "test.pdf");
      fs.writeFileSync(testFile, "fake pdf content");

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const client = new DoclingClient("http://localhost:5001");
      await expect(client.convertFile(testFile)).rejects.toThrow(/no document/);
    });
  });

  describe("chunkFile", () => {
    it("throws on missing file", async () => {
      const client = new DoclingClient("http://localhost:5001");
      await expect(client.chunkFile("/nonexistent/file.pdf")).rejects.toThrow(DoclingClientError);
    });

    it("sends file and parses chunked response", async () => {
      const testFile = path.join(tmpDir, "test.pdf");
      fs.writeFileSync(testFile, "fake pdf content");

      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            chunks: [
              { text: "Chapter 1 content", meta: { page: 1, headings: ["Chapter 1"] } },
              { text: "Chapter 2 content", meta: { page: 3, headings: ["Chapter 2"] } },
            ],
            documents: [{ num_pages: 5, input_format: "pdf" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const client = new DoclingClient("http://localhost:5001");
      const result = await client.chunkFile(testFile);
      expect(result.chunks).toHaveLength(2);
      expect(result.chunks[0].text).toBe("Chapter 1 content");
      expect(result.chunks[0].page).toBe(1);
      expect(result.chunks[0].section).toBe("Chapter 1");
      expect(result.chunks[1].section).toBe("Chapter 2");
      expect(result.pages).toBe(5);
    });
  });
});

// =========================================================================
// DoclingServerManager
// =========================================================================

describe("DoclingServerManager", () => {
  it("defaults to localhost:5001", () => {
    const manager = new DoclingServerManager();
    expect(manager.getUrl()).toBe("http://127.0.0.1:5001");
  });

  it("uses custom URL", () => {
    const manager = new DoclingServerManager("http://myhost:9999");
    expect(manager.getUrl()).toBe("http://myhost:9999");
  });

  it("starts as not running", () => {
    const manager = new DoclingServerManager();
    expect(manager.isStarted()).toBe(false);
  });

  it("reports loopback URL as not remote", () => {
    const manager = new DoclingServerManager("http://127.0.0.1:5001");
    expect(manager.isRemote()).toBe(false);
  });

  it("reports localhost URL as not remote", () => {
    const manager = new DoclingServerManager("http://localhost:5001");
    expect(manager.isRemote()).toBe(false);
  });

  it("reports non-loopback URL as remote", () => {
    const manager = new DoclingServerManager("http://docling.internal:5001");
    expect(manager.isRemote()).toBe(true);
  });

  it("warns on HTTP to non-loopback host", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    new DoclingServerManager("http://remote-server:5001");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("WARNING"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("HTTPS"));
    warnSpy.mockRestore();
  });

  it("does not warn on HTTPS to non-loopback host", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    new DoclingServerManager("https://remote-server:5001");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does not warn on HTTP to loopback", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    new DoclingServerManager("http://127.0.0.1:5001");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("detects already running server", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    const manager = new DoclingServerManager();
    await manager.ensureRunning();
    expect(manager.isStarted()).toBe(true);
    vi.restoreAllMocks();
  });
});

// =========================================================================
// DocumentStore
// =========================================================================

describe("DocumentStore", () => {
  let tmpDir: string;
  let store: DocumentStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docling-store-test-"));
    store = new DocumentStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("addDocument", () => {
    it("adds a document with chunks", () => {
      const doc = store.addDocument(
        { name: "test.pdf", path: "/tmp/test.pdf", format: "pdf", pages: 5, sizeBytes: 1024 },
        [
          { text: "Chapter 1 content", page: 1, section: "Chapter 1" },
          { text: "Chapter 2 content", page: 3, section: "Chapter 2" },
        ],
      );

      expect(doc.id).toBeTruthy();
      expect(doc.name).toBe("test.pdf");
      expect(doc.chunks).toBe(2);
      expect(doc.pages).toBe(5);
      expect(doc.ingestedAt).toBeTruthy();
    });

    it("persists to disk", () => {
      store.addDocument(
        { name: "persist.pdf", path: "/tmp/persist.pdf", format: "pdf", pages: 1, sizeBytes: 512 },
        [{ text: "content" }],
      );

      const store2 = new DocumentStore(tmpDir);
      expect(store2.documentCount()).toBe(1);
      expect(store2.listDocuments()[0].name).toBe("persist.pdf");
    });

    it("persists chunks to disk", () => {
      const doc = store.addDocument(
        { name: "chunks.pdf", path: "/tmp/chunks.pdf", format: "pdf", pages: 2, sizeBytes: 256 },
        [{ text: "chunk 1" }, { text: "chunk 2" }],
      );

      const store2 = new DocumentStore(tmpDir);
      const chunks = store2.getChunks(doc.id);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].text).toBe("chunk 1");
    });
  });

  describe("removeDocument", () => {
    it("removes document and chunks", () => {
      const doc = store.addDocument(
        { name: "remove.pdf", path: "/tmp/remove.pdf", format: "pdf", pages: 1, sizeBytes: 100 },
        [{ text: "content" }],
      );

      expect(store.removeDocument(doc.id)).toBe(true);
      expect(store.documentCount()).toBe(0);
      expect(store.getChunks(doc.id)).toHaveLength(0);
    });

    it("returns false for unknown document", () => {
      expect(store.removeDocument("nonexistent")).toBe(false);
    });
  });

  describe("findDocumentByName", () => {
    it("finds document by filename", () => {
      store.addDocument(
        { name: "findme.pdf", path: "/tmp/findme.pdf", format: "pdf", pages: 1, sizeBytes: 100 },
        [{ text: "content" }],
      );

      const found = store.findDocumentByName("findme.pdf");
      expect(found).toBeDefined();
      expect(found?.name).toBe("findme.pdf");
    });

    it("returns undefined for unknown name", () => {
      expect(store.findDocumentByName("unknown.pdf")).toBeUndefined();
    });
  });

  describe("searchByKeyword", () => {
    beforeEach(() => {
      store.addDocument(
        {
          name: "handbook.pdf",
          path: "/tmp/handbook.pdf",
          format: "pdf",
          pages: 10,
          sizeBytes: 5000,
        },
        [
          {
            text: "Employees are entitled to 20 days of paid vacation per year.",
            page: 23,
            section: "Vacation Policy",
          },
          {
            text: "The company provides health insurance for all full-time employees.",
            page: 30,
            section: "Benefits",
          },
          {
            text: "Termination requires 30 days written notice from either party.",
            page: 45,
            section: "Termination",
          },
        ],
      );
      store.addDocument(
        { name: "invoice.pdf", path: "/tmp/invoice.pdf", format: "pdf", pages: 1, sizeBytes: 200 },
        [
          { text: "Invoice total: $4,250.00. Due date: March 15, 2026.", page: 1 },
          { text: "Line items: Software license $3,000, Support $1,250.", page: 1 },
        ],
      );
    });

    it("finds chunks matching query terms", () => {
      const results = store.searchByKeyword("vacation");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].chunk.text).toContain("vacation");
    });

    it("returns document metadata with results", () => {
      const results = store.searchByKeyword("vacation");
      expect(results[0].document.name).toBe("handbook.pdf");
      expect(results[0].chunk.page).toBe(23);
      expect(results[0].chunk.section).toBe("Vacation Policy");
    });

    it("searches across multiple documents", () => {
      const results = store.searchByKeyword("invoice total");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].document.name).toBe("invoice.pdf");
    });

    it("returns empty for no matches", () => {
      const results = store.searchByKeyword("quantum physics");
      expect(results).toHaveLength(0);
    });

    it("ranks by match score", () => {
      const results = store.searchByKeyword("employees insurance");
      expect(results[0].chunk.text).toContain("insurance");
      expect(results[0].score).toBeGreaterThan(0);
    });

    it("respects limit parameter", () => {
      const results = store.searchByKeyword("the", 1);
      expect(results).toHaveLength(1);
    });

    it("handles empty query", () => {
      const results = store.searchByKeyword("");
      expect(results).toHaveLength(0);
    });

    it("handles whitespace-only query", () => {
      const results = store.searchByKeyword("   ");
      expect(results).toHaveLength(0);
    });
  });

  describe("counts", () => {
    it("counts documents", () => {
      expect(store.documentCount()).toBe(0);
      store.addDocument(
        { name: "a.pdf", path: "/a.pdf", format: "pdf", pages: 1, sizeBytes: 100 },
        [{ text: "a" }],
      );
      expect(store.documentCount()).toBe(1);
    });

    it("counts chunks across documents", () => {
      store.addDocument(
        { name: "a.pdf", path: "/a.pdf", format: "pdf", pages: 1, sizeBytes: 100 },
        [{ text: "a1" }, { text: "a2" }],
      );
      store.addDocument(
        { name: "b.pdf", path: "/b.pdf", format: "pdf", pages: 1, sizeBytes: 100 },
        [{ text: "b1" }],
      );
      expect(store.chunkCount()).toBe(3);
    });
  });

  describe("empty store", () => {
    it("lists no documents", () => {
      expect(store.listDocuments()).toEqual([]);
    });

    it("returns empty chunks for unknown doc", () => {
      expect(store.getChunks("nonexistent")).toEqual([]);
    });

    it("returns empty search results", () => {
      expect(store.searchByKeyword("anything")).toEqual([]);
    });
  });
});

// =========================================================================
// Supported extensions
// =========================================================================

describe("SUPPORTED_EXTENSIONS", () => {
  it("includes PDF", () => {
    expect(SUPPORTED_EXTENSIONS.has(".pdf")).toBe(true);
  });

  it("includes Word", () => {
    expect(SUPPORTED_EXTENSIONS.has(".docx")).toBe(true);
  });

  it("includes PowerPoint", () => {
    expect(SUPPORTED_EXTENSIONS.has(".pptx")).toBe(true);
  });

  it("includes Excel", () => {
    expect(SUPPORTED_EXTENSIONS.has(".xlsx")).toBe(true);
  });

  it("includes HTML", () => {
    expect(SUPPORTED_EXTENSIONS.has(".html")).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has(".htm")).toBe(true);
  });

  it("includes images", () => {
    expect(SUPPORTED_EXTENSIONS.has(".png")).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has(".jpg")).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has(".jpeg")).toBe(true);
  });

  it("includes LaTeX", () => {
    expect(SUPPORTED_EXTENSIONS.has(".tex")).toBe(true);
  });

  it("includes CSV and markdown", () => {
    expect(SUPPORTED_EXTENSIONS.has(".csv")).toBe(true);
    expect(SUPPORTED_EXTENSIONS.has(".md")).toBe(true);
  });

  it("does not include unsupported formats", () => {
    expect(SUPPORTED_EXTENSIONS.has(".exe")).toBe(false);
    expect(SUPPORTED_EXTENSIONS.has(".zip")).toBe(false);
    expect(SUPPORTED_EXTENSIONS.has(".mp4")).toBe(false);
  });
});
