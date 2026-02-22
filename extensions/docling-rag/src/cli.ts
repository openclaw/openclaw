import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { chunkMarkdown } from "./chunker.js";
import { parseConfig } from "./config.js";
import { isSupportedFormat, runDocling } from "./docling-runner.js";
import { DoclingStore } from "./storage.js";

export function registerDoclingCli(
  program: Command,
  api: { resolvePath: (p: string) => string; pluginConfig?: unknown },
) {
  const docsCmd = program.command("docling").description("Docling RAG document management");

  docsCmd
    .command("ingest <path>")
    .description("Ingest a document (PDF, Word, Excel, etc.)")
    .action(async (inputPath: string) => {
      const cfg = parseConfig(api.pluginConfig);
      if (!cfg.enabled || !cfg.embedding.apiKey) {
        console.error("docling-rag: plugin disabled or missing embedding.apiKey");
        process.exitCode = 1;
        return;
      }
      const resolved = api.resolvePath(inputPath);
      try {
        await fs.access(resolved);
      } catch {
        console.error(`File not found: ${resolved}`);
        process.exitCode = 1;
        return;
      }
      if (!isSupportedFormat(resolved)) {
        console.error(`Unsupported format: ${path.extname(resolved)}`);
        process.exitCode = 1;
        return;
      }
      const result = await runDocling(resolved, {
        doclingPath: cfg.doclingPath,
        timeoutMs: 120_000,
      });
      if (!result.ok) {
        console.error(`Docling failed: ${result.error}`);
        process.exitCode = 1;
        return;
      }
      const chunks = chunkMarkdown(result.markdown, {
        maxChars: cfg.chunkSize,
        overlap: cfg.chunkOverlap,
      });
      const dbPath = api.resolvePath(cfg.dbPath);
      const store = new DoclingStore(
        dbPath,
        cfg.embedding.apiKey,
        cfg.embedding.model,
      );
      const documentId = `doc-${Date.now()}-${path.basename(resolved)}`;
      const count = await store.ingest(documentId, path.basename(resolved), resolved, chunks);
      console.log(`✓ ${path.basename(resolved)} (${count} chunks)`);
    });

  docsCmd.command("list").description("List ingested documents").action(async () => {
    const cfg = parseConfig(api.pluginConfig);
    if (!cfg.enabled || !cfg.embedding.apiKey) {
      console.error("docling-rag: plugin disabled or missing embedding.apiKey");
      process.exitCode = 1;
      return;
    }
    const dbPath = api.resolvePath(cfg.dbPath);
    const store = new DoclingStore(
      dbPath,
      cfg.embedding.apiKey,
      cfg.embedding.model,
    );
    const docs = await store.listDocuments();
    if (docs.length === 0) {
      console.log("No documents ingested.");
      return;
    }
    for (const d of docs) {
      console.log(`  ${d.name} (${d.chunkCount} chunks) - ${d.id}`);
    }
  });

  docsCmd
    .command("search <query>")
    .option("-l, --limit <n>", "Max results", "5")
    .description("Search ingested documents")
    .action(async (query: string, opts: { limit?: string }) => {
      const cfg = parseConfig(api.pluginConfig);
      if (!cfg.enabled || !cfg.embedding.apiKey) {
        console.error("docling-rag: plugin disabled or missing embedding.apiKey");
        process.exitCode = 1;
        return;
      }
      const limit = parseInt(opts.limit ?? "5", 10) || 5;
      const dbPath = api.resolvePath(cfg.dbPath);
      const store = new DoclingStore(
        dbPath,
        cfg.embedding.apiKey,
        cfg.embedding.model,
      );
      const results = await store.search(query, limit);
      if (results.length === 0) {
        console.log("No matches.");
        return;
      }
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        console.log(`\n--- ${i + 1}. ${r.chunk.documentName} (${(r.score * 100).toFixed(0)}%) ---`);
        console.log(r.chunk.text.slice(0, 500) + (r.chunk.text.length > 500 ? "..." : ""));
      }
    });

  docsCmd
    .command("remove <documentId>")
    .description("Remove a document from the knowledge base")
    .action(async (documentId: string) => {
      const cfg = parseConfig(api.pluginConfig);
      if (!cfg.enabled || !cfg.embedding.apiKey) {
        console.error("docling-rag: plugin disabled or missing embedding.apiKey");
        process.exitCode = 1;
        return;
      }
      const dbPath = api.resolvePath(cfg.dbPath);
      const store = new DoclingStore(
        dbPath,
        cfg.embedding.apiKey,
        cfg.embedding.model,
      );
      const removed = await store.removeDocument(documentId);
      console.log(removed ? "Document removed." : "Document not found.");
    });
}
